// The client's TradeStation connection: authorize, link, list accounts, disconnect.
// docs/tradestation-integration.md#credentials-and-oauth. Secrets and tokens are decrypted here
// and nowhere else; nothing this module returns or logs contains one.
import { ROTATING_REFRESH_LIFETIME_MS } from "#lib/domain/config.ts";
import type { CredentialCipher } from "./crypto.ts";
import {
  connectionHealth,
  entryBlock,
  type ConnectionHealth,
  type StoredConnectionState,
} from "#lib/domain/connection.ts";
import { holdForReconciliation, reconciliationPending, type TokenRefresher } from "./refresh.ts";
import { failure, success, type EngineResult } from "./rpc.ts";
import { writeEvent } from "./events.ts";
import type { Mode } from "./mode.ts";
import { listTradableAccounts, type BrokerAccount } from "./tradestation/accounts.ts";
import { authorizeUrl, exchangeCode, revokeRefreshToken } from "./tradestation/auth.ts";
import type { BrokerFailure } from "./tradestation/endpoints.ts";

/** Long enough to log in at TradeStation (passkey, 2FA), short enough to be a one-shot. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface ConnectionContext {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly db: D1Database;
  /** The session user the Durable Object is named after; never a request value. */
  readonly userId: string;
  readonly now: number;
  /** Built on demand: reading the status needs no key. Throws CredentialsKeyError when it is unusable. */
  readonly cipher: () => Promise<CredentialCipher>;
  /** The client's one refresher, owned by the Durable Object. */
  readonly tokens: TokenRefresher;
}

export type ConnectionView =
  | { readonly mode: Mode; readonly status: "NOT_CONNECTED" }
  | {
      readonly mode: Mode;
      readonly status: "CONNECTED";
      readonly health: ConnectionHealth;
      /** True while a new entry would be refused: unusable connection or reconciliation pending. */
      readonly entriesBlocked: boolean;
      readonly accounts: readonly BrokerAccount[];
      /** Connect time + 24 h until the SIM spike (#21) verifies it; null only on rows stored before that. */
      readonly refreshExpiresAt: number | null;
      readonly lastOkAt: number | null;
    };

const redirectUri = (origin: string) => `${origin}/conexion/callback`;
const secretContext = (userId: string) => `${userId}:client_secret`;
const refreshContext = (userId: string) => `${userId}:refresh_token`;

function log(
  { sql, now }: ConnectionContext,
  level: "info" | "warn" | "error",
  type: string,
  data?: Record<string, unknown>,
): void {
  // `data` is limited to counts and statuses by the callers; the writer also scrubs secret-like keys.
  writeEvent(sql, now, { mode: "SIM", level, type, message: type, data });
}

const FAILURE_CODES = {
  REJECTED: "TOKEN_EXCHANGE_FAILED",
  UNAVAILABLE: "BROKER_UNAVAILABLE",
  INVALID_RESPONSE: "INVALID_BROKER_RESPONSE",
} as const satisfies Record<BrokerFailure, string>;

function randomState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function beginConnection(
  ctx: ConnectionContext,
  args: { clientId: string; clientSecret: string; origin: string },
): Promise<EngineResult<{ authorizeUrl: string }>> {
  const cipher = await ctx.cipher();
  const clientSecretEnc = await cipher.encrypt(args.clientSecret, secretContext(ctx.userId));
  const state = randomState();
  // No await between the delete and the insert: a new attempt replaces any earlier one.
  ctx.storage.transactionSync(() => {
    ctx.sql.exec("DELETE FROM oauth_attempts");
    ctx.sql.exec(
      "INSERT INTO oauth_attempts (state, mode, client_id, client_secret_enc, key_id, expires_at) VALUES (?, 'SIM', ?, ?, ?, ?)",
      state,
      args.clientId,
      clientSecretEnc,
      cipher.keyId,
      ctx.now + ATTEMPT_TTL_MS,
    );
  });
  log(ctx, "info", "broker.authorize_started");
  return success({
    authorizeUrl: authorizeUrl({
      clientId: args.clientId,
      redirectUri: redirectUri(args.origin),
      state,
    }),
  });
}

interface AttemptRow extends Record<string, SqlStorageValue> {
  client_id: string;
  client_secret_enc: string;
  expires_at: number;
}

export async function completeConnection(
  ctx: ConnectionContext,
  args: { code: string; state: string; origin: string },
): Promise<EngineResult<ConnectionView>> {
  // Consume the state before any await: a replay finds nothing, whatever happens next. The DO is
  // the client's own, so a state issued to someone else is simply not here.
  const attempt = ctx.storage.transactionSync(() => {
    const row = ctx.sql
      .exec<AttemptRow>(
        "SELECT client_id, client_secret_enc, expires_at FROM oauth_attempts WHERE state = ? AND mode = 'SIM'",
        args.state,
      )
      .toArray()[0];
    ctx.sql.exec("DELETE FROM oauth_attempts WHERE state = ?", args.state);
    return row;
  });
  if (attempt === undefined || attempt.expires_at <= ctx.now) {
    log(ctx, "warn", "broker.state_rejected");
    return failure("STATE_INVALID");
  }

  const cipher = await ctx.cipher();
  const clientSecret = await cipher.decrypt(attempt.client_secret_enc, secretContext(ctx.userId));
  const clientId = attempt.client_id;

  const exchanged = await exchangeCode({
    clientId,
    clientSecret,
    code: args.code,
    redirectUri: redirectUri(args.origin),
  });
  if (!exchanged.ok) {
    log(ctx, "warn", "broker.token_exchange_failed", {
      failure: exchanged.failure,
      status: exchanged.status,
    });
    return failure(FAILURE_CODES[exchanged.failure]);
  }
  const tokens = exchanged.value;

  const listed = await listTradableAccounts(tokens.accessToken);
  if (!listed.ok) {
    // Do not keep a grant the client cannot see; undo it at TradeStation, best effort.
    const revoked = await revokeRefreshToken({
      clientId,
      clientSecret,
      refreshToken: tokens.refreshToken,
    });
    if (revoked.ok) {
      // Revocation covers every refresh token of the API key, so a connection already stored for
      // this same key just died. A connection with another key is untouched.
      const dead = await ctx.db
        .prepare("DELETE FROM broker_connection WHERE user_id = ? AND client_id = ?")
        .bind(ctx.userId, clientId)
        .run();
      if (dead.meta.changes > 0) ctx.sql.exec("DELETE FROM broker_accounts");
    }
    log(ctx, "warn", "broker.accounts_failed", { failure: listed.failure, status: listed.status });
    return failure(FAILURE_CODES[listed.failure]);
  }

  // Switching to another API key leaves the previous key's grant alive at TradeStation; undo it,
  // best effort, before it is overwritten and forgotten.
  const previous = await ctx.db
    .prepare(
      "SELECT client_id, client_secret_enc, refresh_token_enc FROM broker_connection WHERE user_id = ?",
    )
    .bind(ctx.userId)
    .first<{ client_id: string; client_secret_enc: string; refresh_token_enc: string }>();
  if (previous !== null && previous.client_id !== clientId) {
    try {
      await revokeRefreshToken({
        clientId: previous.client_id,
        clientSecret: await cipher.decrypt(previous.client_secret_enc, secretContext(ctx.userId)),
        refreshToken: await cipher.decrypt(previous.refresh_token_enc, refreshContext(ctx.userId)),
      });
    } catch {
      // Undecryptable (key rotated): nothing to revoke with.
    }
  }

  const refreshTokenEnc = await cipher.encrypt(tokens.refreshToken, refreshContext(ctx.userId));
  const secretEnc = await cipher.encrypt(clientSecret, secretContext(ctx.userId));
  // Conservative: assume the key rotates and the 24 h absolute lifetime counts from the
  // authorization (docs/tradestation-integration.md#token-lifetime, (verify) in #21).
  const refreshExpiresAt = ctx.now + ROTATING_REFRESH_LIFETIME_MS;
  await ctx.db
    .prepare(
      `INSERT INTO broker_connection
         (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
       VALUES (?, ?, ?, ?, ?, ?, 'CONNECTED', ?)
       ON CONFLICT (user_id) DO UPDATE SET
         client_id = excluded.client_id,
         client_secret_enc = excluded.client_secret_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         key_id = excluded.key_id,
         refresh_expires_at = excluded.refresh_expires_at,
         status = 'CONNECTED',
         last_ok_at = excluded.last_ok_at`,
    )
    .bind(ctx.userId, clientId, secretEnc, refreshTokenEnc, cipher.keyId, refreshExpiresAt, ctx.now)
    .run();

  ctx.storage.transactionSync(() => {
    ctx.sql.exec("DELETE FROM broker_accounts WHERE mode = 'SIM'");
    for (const account of listed.value) {
      ctx.sql.exec(
        "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', ?, ?)",
        account.accountId,
        account.accountType,
      );
    }
    // Orders may have moved while we were not connected: entries wait for a reconciliation
    // (docs/order-lifecycle.md#reconciliation). Atomic with the account cache, no await between.
    holdForReconciliation(ctx.storage);
  });
  // Kept in memory only; the refresher renews it before it runs out.
  ctx.tokens.seed(tokens.accessToken, tokens.expiresInSeconds);
  log(ctx, "info", "broker.connected", { accounts: listed.value.length });
  return success({
    mode: "SIM",
    status: "CONNECTED",
    health: { status: "ok" },
    entriesBlocked: entriesBlocked({ status: "ok" }, ctx),
    accounts: listed.value,
    refreshExpiresAt,
    lastOkAt: ctx.now,
  });
}

function entriesBlocked(health: ConnectionHealth, ctx: ConnectionContext): boolean {
  return entryBlock({ health, reconciliationPending: reconciliationPending(ctx.storage) }) !== null;
}

/** An unrecognised value is treated as an error, never as healthy. */
function storedState(status: string): StoredConnectionState {
  return status === "CONNECTED" || status === "EXPIRED" || status === "REVOKED" ? status : "ERROR";
}

export async function readConnection(ctx: ConnectionContext): Promise<ConnectionView> {
  const row = await ctx.db
    .prepare(
      "SELECT refresh_expires_at, last_ok_at, status FROM broker_connection WHERE user_id = ?",
    )
    .bind(ctx.userId)
    .first<{ refresh_expires_at: number | null; last_ok_at: number | null; status: string }>();
  if (row === null) return { mode: "SIM", status: "NOT_CONNECTED" };
  const accounts = ctx.sql
    .exec<{ account_id: string; account_type: "Cash" | "Margin" }>(
      "SELECT account_id, account_type FROM broker_accounts WHERE mode = 'SIM' ORDER BY account_id",
    )
    .toArray()
    .map(({ account_id, account_type }) => ({ accountId: account_id, accountType: account_type }));
  const health = connectionHealth({
    stored: storedState(row.status),
    refreshExpiresAt: row.refresh_expires_at,
    now: ctx.now,
  });
  return {
    mode: "SIM",
    status: "CONNECTED",
    health,
    entriesBlocked: entriesBlocked(health, ctx),
    accounts,
    refreshExpiresAt: row.refresh_expires_at,
    lastOkAt: row.last_ok_at,
  };
}

/**
 * Revokes at TradeStation, then forgets the credentials. Revocation covers every refresh token of
 * the client's API key (official docs). If it cannot be done the credentials are still deleted, and
 * the caller is told so the client can revoke from their TradeStation account.
 */
export async function disconnect(ctx: ConnectionContext): Promise<{ revoked: boolean }> {
  const row = await ctx.db
    .prepare(
      "SELECT client_id, client_secret_enc, refresh_token_enc FROM broker_connection WHERE user_id = ?",
    )
    .bind(ctx.userId)
    .first<{ client_id: string; client_secret_enc: string; refresh_token_enc: string }>();

  let revoked = false;
  if (row !== null) {
    try {
      const cipher = await ctx.cipher();
      const outcome = await revokeRefreshToken({
        clientId: row.client_id,
        clientSecret: await cipher.decrypt(row.client_secret_enc, secretContext(ctx.userId)),
        refreshToken: await cipher.decrypt(row.refresh_token_enc, refreshContext(ctx.userId)),
      });
      revoked = outcome.ok;
    } catch {
      // A value that no longer decrypts (key rotated) cannot be revoked, only deleted.
    }
    // Tied to the token read above: a connection completed during the revoke await has another
    // token and must survive.
    const removed = await ctx.db
      .prepare("DELETE FROM broker_connection WHERE user_id = ? AND refresh_token_enc = ?")
      .bind(ctx.userId, row.refresh_token_enc)
      .run();
    // Same reason for the account cache: it belongs to the connection that was just removed.
    if (removed.meta.changes === 0) return { revoked };
  }
  ctx.tokens.forget();
  ctx.storage.transactionSync(() => {
    ctx.sql.exec("DELETE FROM broker_accounts");
    ctx.sql.exec("DELETE FROM oauth_attempts");
    // Without credentials nothing watches the positions: their protection is unverified and
    // entries stay blocked until a later connection has been reconciled.
    holdForReconciliation(ctx.storage);
  });
  log(ctx, revoked || row === null ? "info" : "warn", "broker.disconnected", { revoked });
  return { revoked };
}
