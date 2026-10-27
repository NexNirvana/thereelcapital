// Keeps one client's TradeStation access token usable (docs/tradestation-integration.md#token-lifetime).
// The access token lives in this object's memory only; the refresh token is read from and written
// back to D1 encrypted. One instance per Durable Object, so one refresher per client, and a refresh
// already in flight is shared (single flight) rather than repeated.
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  ROTATING_REFRESH_LIFETIME_MS,
} from "#lib/domain/config.ts";
import type { StoredConnectionState } from "#lib/domain/connection.ts";
import { UnknownKeyIdError, type CredentialCipher } from "./crypto.ts";
import { logEvent } from "./events.ts";
import { refreshAccessToken } from "./tradestation/auth.ts";
import { timedD1 } from "./timing.ts";

/** Marks that entries stay blocked until reconciliation, even once the connection works again. */
const RECONCILIATION_PENDING_KEY = "reconciliation_pending";

/**
 * A rotated refresh token that D1 has not accepted yet, encrypted, in Durable Object storage so it
 * survives an eviction. TradeStation has already retired the old token, so this is the only valid
 * copy. `replaces` is the D1 ciphertext it supersedes.
 */
const UNSAVED_REFRESH_KEY = "unsaved_refresh_token";
interface UnsavedRefreshToken {
  readonly tokenEnc: string;
  readonly replaces: string;
  /** Key it was sealed with; absent on a copy saved before key rotation existed (current key). */
  readonly keyId?: string;
}

export interface RefresherDeps {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly db: D1Database;
  /** The session user the Durable Object is named after. */
  readonly userId: string;
  readonly cipher: () => Promise<CredentialCipher>;
  /** Epoch ms. Injected so tests drive time. */
  readonly clock: () => number;
  /** Pause before a retry of a refresh that TradeStation could not answer. */
  readonly retryDelayMs: number;
  /** Called after anything that changes the stored connection, so a copy of it can be dropped. */
  readonly changed?: () => void;
}

export type RefreshOutcome =
  /** The access token is usable until `accessExpiresAt`. */
  | { readonly kind: "ready"; readonly accessExpiresAt: number }
  /** No stored connection. */
  | { readonly kind: "none" }
  /** Refreshing cannot work until the client reconnects. */
  | { readonly kind: "terminal"; readonly state: "EXPIRED" | "REVOKED" }
  /** Might pass by itself; try again later. */
  | { readonly kind: "retryable" };

interface ConnectionRow extends Record<string, SqlStorageValue> {
  client_id: string;
  client_secret_enc: string;
  refresh_token_enc: string;
  key_id: string;
  refresh_expires_at: number | null;
  status: string;
}

const secretContext = (userId: string) => `${userId}:client_secret`;
const refreshContext = (userId: string) => `${userId}:refresh_token`;

export class TokenRefresher {
  #access: { token: string; expiresAt: number } | null = null;
  #inflight: Promise<RefreshOutcome> | null = null;
  #generation = 0;

  constructor(private readonly deps: RefresherDeps) {}

  /** The token obtained when the client connected, so the first refresh waits for its time. */
  seed(accessToken: string, expiresInSeconds: number): void {
    this.#generation++;
    this.deps.changed?.();
    this.#access = { token: accessToken, expiresAt: this.deps.clock() + expiresInSeconds * 1000 };
    this.deps.storage.kv.delete(UNSAVED_REFRESH_KEY);
  }

  forget(): void {
    this.#generation++;
    this.deps.changed?.();
    this.#access = null;
    this.deps.storage.kv.delete(UNSAVED_REFRESH_KEY);
  }

  /** When the access token should be refreshed; null while there is none. */
  nextRefreshAt(): number | null {
    return this.#access === null ? null : this.#access.expiresAt - ACCESS_TOKEN_REFRESH_MARGIN_MS;
  }

  /** The current access token, refreshed first when it is close to expiring. Never logged. */
  async accessToken(): Promise<
    { ok: true; token: string } | { ok: false; outcome: RefreshOutcome }
  > {
    const current = this.#access;
    if (
      current !== null &&
      current.expiresAt - this.deps.clock() > ACCESS_TOKEN_REFRESH_MARGIN_MS
    ) {
      return { ok: true, token: current.token };
    }
    const outcome = await this.refresh();
    const refreshed = this.#access;
    // A failed refresh may leave a token that still has minutes to live; it is still valid.
    if (refreshed !== null && refreshed.expiresAt > this.deps.clock()) {
      return { ok: true, token: refreshed.token };
    }
    return { ok: false, outcome };
  }

  /** Concurrent callers share one request; the slot is taken before the first await. */
  refresh(): Promise<RefreshOutcome> {
    this.#inflight ??= this.#refreshOnce().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #refreshOnce(): Promise<RefreshOutcome> {
    const { db, userId, clock } = this.deps;
    // seed() and forget() bump this: a connect or disconnect that lands while a request is out
    // makes every later step of this refresh stale, and it drops its result instead of applying it.
    const generation = this.#generation;
    const row = await timedD1(
      "token_row",
      db
        .prepare(
          `SELECT client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status
           FROM broker_connection WHERE user_id = ?`,
        )
        .bind(userId)
        .first<ConnectionRow>(),
    );
    if (generation !== this.#generation) return { kind: "none" };
    if (row === null) {
      this.forget();
      return { kind: "none" };
    }
    // A recorded terminal failure stands until the client reconnects, which replaces the row.
    if (row.status === "EXPIRED" || row.status === "REVOKED") {
      this.#access = null;
      return { kind: "terminal", state: row.status };
    }
    // The absolute lifetime of a rotating token has run out: TradeStation would refuse it anyway.
    if (row.refresh_expires_at !== null && row.refresh_expires_at <= clock()) {
      return this.#fail(row, generation, { kind: "terminal", state: "EXPIRED" }, "EXPIRY_PASSED");
    }

    let clientSecret: string;
    let refreshToken: string;
    let storedToken: string;
    let cipher: CredentialCipher;
    try {
      cipher = await this.deps.cipher();
      clientSecret = await cipher.decrypt(row.client_secret_enc, secretContext(userId), row.key_id);
      storedToken = await cipher.decrypt(row.refresh_token_enc, refreshContext(userId), row.key_id);
      const unsaved = this.deps.storage.kv.get<UnsavedRefreshToken>(UNSAVED_REFRESH_KEY);
      if (unsaved?.replaces === row.refresh_token_enc) {
        refreshToken = await cipher.decrypt(
          unsaved.tokenEnc,
          refreshContext(userId),
          unsaved.keyId ?? row.key_id,
        );
      } else {
        // Superseded (the row was replaced by a reconnect): nothing to recover.
        if (unsaved !== undefined) this.deps.storage.kv.delete(UNSAVED_REFRESH_KEY);
        refreshToken = storedToken;
      }
    } catch (error) {
      // A key_id that neither key matches never recovers by itself: the client must reconnect.
      if (error instanceof UnknownKeyIdError) {
        return this.#fail(row, generation, { kind: "terminal", state: "EXPIRED" }, "KEY_UNKNOWN");
      }
      // A missing or malformed CREDENTIALS_KEY is a failure like any other: entries must stop.
      return this.#fail(row, generation, { kind: "retryable" }, "CREDENTIALS");
    }

    const result = await refreshAccessToken(
      { clientId: row.client_id, clientSecret, refreshToken },
      this.deps.retryDelayMs,
    );
    if (generation !== this.#generation) return { kind: "none" };
    const now = clock();

    if (!result.ok) {
      const outcome: RefreshOutcome =
        result.failure === "REJECTED"
          ? { kind: "terminal", state: "REVOKED" }
          : { kind: "retryable" };
      return this.#fail(row, generation, outcome, result.failure, result.status);
    }

    const tokens = result.value;
    const accessExpiresAt = now + tokens.expiresInSeconds * 1000;
    this.#access = { token: tokens.accessToken, expiresAt: accessExpiresAt };

    // What the client must hold from now on: the new token if the response rotated, otherwise the
    // one just used, which differs from the stored one only when an earlier rotation was not saved.
    const current = tokens.rotatedRefreshToken ?? refreshToken;
    // A row still on the previous key is re-encrypted now rather than at the next rotation.
    if (current !== storedToken || row.key_id !== cipher.keyId) {
      await this.#persistRefreshToken(row, generation, cipher, clientSecret, current, now);
    } else {
      await this.#recordSuccess(row, now);
    }
    return { kind: "ready", accessExpiresAt };
  }

  /**
   * One statement, so the refresh token, its absolute expiry and the status change together.
   * Guarded by the old ciphertext: if the client reconnected or disconnected while the request was
   * out, the row is not ours any more and nothing is written.
   */
  async #persistRefreshToken(
    row: ConnectionRow,
    generation: number,
    cipher: CredentialCipher,
    clientSecret: string,
    refreshToken: string,
    now: number,
  ): Promise<void> {
    const { db, userId, sql } = this.deps;
    try {
      const refreshTokenEnc = await cipher.encrypt(refreshToken, refreshContext(userId));
      // Before the D1 write, and synchronously after the await above: from here on the token
      // survives a failed write and an eviction.
      if (generation === this.#generation) {
        this.deps.storage.kv.put<UnsavedRefreshToken>(UNSAVED_REFRESH_KEY, {
          tokenEnc: refreshTokenEnc,
          replaces: row.refresh_token_enc,
          keyId: cipher.keyId,
        });
      }
      // key_id covers both ciphertexts, so a key change re-encrypts the secret in the same statement.
      const secretEnc =
        row.key_id === cipher.keyId
          ? row.client_secret_enc
          : await cipher.encrypt(clientSecret, secretContext(userId));
      // Absolute lifetime: it starts when rotation is first seen and refreshes do not extend it.
      const refreshExpiresAt = row.refresh_expires_at ?? now + ROTATING_REFRESH_LIFETIME_MS;
      const written = await db
        .prepare(
          `UPDATE broker_connection
              SET refresh_token_enc = ?, client_secret_enc = ?, key_id = ?,
                  refresh_expires_at = ?, status = 'CONNECTED', last_ok_at = ?
            WHERE user_id = ? AND refresh_token_enc = ?`,
        )
        .bind(
          refreshTokenEnc,
          secretEnc,
          cipher.keyId,
          refreshExpiresAt,
          now,
          userId,
          row.refresh_token_enc,
        )
        .run();
      if (written.meta.changes === 0) {
        // Someone else replaced the row. Only forget what is ours: a reconnect seeded its own.
        if (generation === this.#generation) this.forget();
        return;
      }
      this.deps.changed?.();
      if (generation === this.#generation) this.deps.storage.kv.delete(UNSAVED_REFRESH_KEY);
      if (row.refresh_expires_at === null) {
        logEvent({ sql, now }, "info", "broker.rotation_detected", { refreshExpiresAt });
      }
      this.#recovered(row, now);
    } catch {
      // The token stays in DO storage and the next refresh writes it, whatever the response says.
      logEvent({ sql, now }, "error", "broker.rotation_not_saved");
    }
  }

  async #recordSuccess(row: ConnectionRow, now: number): Promise<void> {
    await this.deps.db
      .prepare(
        `UPDATE broker_connection SET status = 'CONNECTED', last_ok_at = ?
          WHERE user_id = ? AND refresh_token_enc = ?`,
      )
      .bind(now, this.deps.userId, row.refresh_token_enc)
      .run();
    this.deps.changed?.();
    this.#recovered(row, now);
  }

  #recovered(row: ConnectionRow, now: number): void {
    if (row.status !== "ERROR") return;
    logEvent({ sql: this.deps.sql, now }, "info", "broker.refresh_recovered");
  }

  /**
   * Entries stay blocked and protection is `unverified` from here until a reconciliation says
   * otherwise. Does nothing when the connection changed since this refresh started.
   */
  async #fail(
    row: ConnectionRow,
    generation: number,
    outcome: Exclude<RefreshOutcome, { kind: "ready" | "none" }>,
    reason: string,
    httpStatus?: number,
  ): Promise<RefreshOutcome> {
    const { sql, storage, db, userId, clock } = this.deps;
    if (generation !== this.#generation) return { kind: "none" };
    const state: StoredConnectionState = outcome.kind === "terminal" ? outcome.state : "ERROR";
    if (outcome.kind === "terminal") this.#access = null;
    // Sync part first: the block must hold even if the D1 write below fails.
    holdForReconciliation(storage);
    let recorded = false;
    try {
      const written = await db
        .prepare(
          "UPDATE broker_connection SET status = ? WHERE user_id = ? AND refresh_token_enc = ?",
        )
        .bind(state, userId, row.refresh_token_enc)
        .run();
      recorded = written.meta.changes > 0;
      this.deps.changed?.();
    } catch {
      // The block above already holds; the status is written again by the next failed refresh.
    }
    logEvent({ sql, now: clock() }, "warn", "broker.refresh_failed", {
      state,
      reason,
      status: httpStatus ?? null,
      recorded,
    });
    return outcome;
  }
}

/**
 * Blocks entries and marks every open position's protection `unverified` until `markReconciled`.
 * Used whenever the connection to the broker changed (refresh failed, connected, disconnected),
 * since orders may have moved while we could not see them. Synchronous and atomic.
 */
export function holdForReconciliation(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      "UPDATE positions SET protection_state = 'unverified' WHERE mode = 'SIM' AND status != 'CLOSED'",
    );
    // A counter, not a flag, so markReconciled can tell a hold that happened while it waited.
    storage.kv.put(
      RECONCILIATION_PENDING_KEY,
      (storage.kv.get<number>(RECONCILIATION_PENDING_KEY) ?? 0) + 1,
    );
  });
}

export function reconciliationPending(storage: DurableObjectStorage): boolean {
  return storage.kv.get(RECONCILIATION_PENDING_KEY) !== undefined;
}

/**
 * How many holds have been placed since the last lift (0 when none is pending). A reconciliation
 * takes it before it reads the broker and hands it back to `markReconciled`, so a hold that lands
 * while it reads is not lifted by a snapshot that predates it.
 */
export function reconciliationTicket(storage: DurableObjectStorage): number {
  return storage.kv.get<number>(RECONCILIATION_PENDING_KEY) ?? 0;
}

/**
 * Called by the sync loop (sync.ts) once orders and positions have been re-read from the broker.
 * Refuses while the connection is not usable, so a reconciliation that ran against a dead
 * connection cannot reopen entries. `ticket` is the hold count taken before the broker was read;
 * without it, the count at the time of the call is used.
 */
export async function markReconciled(
  deps: Pick<RefresherDeps, "storage" | "db" | "userId">,
  ticket?: number,
): Promise<boolean> {
  const seen = ticket ?? reconciliationTicket(deps.storage);
  const row = await deps.db
    .prepare("SELECT status FROM broker_connection WHERE user_id = ?")
    .bind(deps.userId)
    .first<{ status: string }>();
  // A refresh that failed while this was waiting bumped the counter: that block is not ours to lift.
  if (row?.status !== "CONNECTED" || reconciliationTicket(deps.storage) !== seen) {
    return false;
  }
  deps.storage.kv.delete(RECONCILIATION_PENDING_KEY);
  return true;
}
