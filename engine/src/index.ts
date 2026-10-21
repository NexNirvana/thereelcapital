import { DurableObject } from "cloudflare:workers";
import {
  beginConnection,
  completeConnection,
  disconnect,
  readConnection,
  type ConnectionContext,
  type ConnectionView,
} from "./connection.ts";
import { REFRESH_REQUEST_RETRY_DELAY_MS, REFRESH_RETRY_DELAY_MS } from "#lib/domain/config.ts";
import { createCipher, CredentialsKeyError } from "./crypto.ts";
import { TokenRefresher } from "./refresh.ts";
import { resolveBroker } from "./broker/provider.ts";
import type { BrokerAdapterShape } from "./broker/adapter.ts";
import {
  prepareEntry,
  sendEntry,
  type EntryContext,
  type PrepareEntryResult,
  type SendEntryResult,
} from "./entries.ts";
import { writeEvent } from "./events.ts";
import { migrate } from "./schema.ts";
import {
  ActivateTrailingArgs,
  BeginConnectionArgs,
  CancelArgs,
  CompleteConnectionArgs,
  decodeArgs,
  ExitArgs,
  failure,
  ModeOnlyArgs,
  PrepareEntryArgs,
  SendEntryArgs,
  success,
  type EngineResult,
} from "./rpc.ts";
import type { Schema } from "effect";
import type { Mode } from "./mode.ts";

type Row = Record<string, SqlStorageValue>;

/**
 * One instance per client, addressed by user id; it only ever knows its own client. Every public
 * method takes `unknown`, decodes it, and rejects anything but SIM before touching storage.
 */
export class ClientCoordinator extends DurableObject<EngineEnv> {
  #tokens: TokenRefresher | null = null;
  #broker: BrokerAdapterShape | null = null;

  constructor(ctx: DurableObjectState, env: EngineEnv) {
    super(ctx, env);
    // Built before the first request is served, so every RPC sees the full schema.
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  ping(): string {
    return "pong";
  }

  /** A sized, guarded preview of an entry. Creates no intent and reserves nothing. */
  prepareEntry(input: unknown): Promise<EngineResult<PrepareEntryResult>> {
    return this.enterWithBroker("prepareEntry", PrepareEntryArgs, input, prepareEntry);
  }

  /** Reserves, persists the intent, then places the MARKET order once. */
  sendEntry(input: unknown): Promise<EngineResult<SendEntryResult>> {
    return this.enterWithBroker("sendEntry", SendEntryArgs, input, sendEntry);
  }

  // Trading methods still to come: decoded and guarded now, implemented by the trading issues.

  exit(input: unknown): EngineResult<never> {
    return this.enter("exit", ExitArgs, input, () => this.notImplemented("exit"));
  }

  cancel(input: unknown): EngineResult<never> {
    return this.enter("cancel", CancelArgs, input, () => this.notImplemented("cancel"));
  }

  activateTrailing(input: unknown): EngineResult<never> {
    return this.enter("activateTrailing", ActivateTrailingArgs, input, () =>
      this.notImplemented("activateTrailing"),
    );
  }

  state(input: unknown): EngineResult<{ mode: Mode; positions: Row[]; activeIntents: Row[] }> {
    return this.enter("state", ModeOnlyArgs, input, ({ mode }) => {
      const sql = this.ctx.storage.sql;
      return success({
        mode,
        positions: sql
          .exec(
            "SELECT id, symbol, original_qty, sold_qty, status FROM positions WHERE mode = ? AND status != 'CLOSED'",
            mode,
          )
          .toArray(),
        activeIntents: sql
          .exec(
            "SELECT id, kind, symbol, state FROM intents WHERE mode = ? AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')",
            mode,
          )
          .toArray(),
      });
    });
  }

  history(input: unknown): EngineResult<{ mode: Mode; intents: Row[] }> {
    return this.enter("history", ModeOnlyArgs, input, ({ mode }) =>
      success({
        mode,
        intents: this.ctx.storage.sql
          .exec(
            "SELECT id, kind, symbol, state, qty, filled_qty, created_at FROM intents WHERE mode = ? ORDER BY created_at DESC LIMIT 100",
            mode,
          )
          .toArray(),
      }),
    );
  }

  /** Status of the client's TradeStation connection and the accounts it can trade. */
  connection(input: unknown): Promise<EngineResult<ConnectionView>> {
    return this.enterWithConnection("connection", ModeOnlyArgs, input, async (ctx) =>
      success(await readConnection(ctx)),
    );
  }

  /** Stores the client's key and secret (encrypted) and returns where to send the browser. */
  beginConnection(input: unknown): Promise<EngineResult<{ authorizeUrl: string }>> {
    return this.enterWithConnection("beginConnection", BeginConnectionArgs, input, (ctx, args) =>
      beginConnection(ctx, args),
    );
  }

  /** The OAuth callback: checks the state, exchanges the code, links the accounts. */
  completeConnection(input: unknown): Promise<EngineResult<ConnectionView>> {
    return this.enterWithConnection(
      "completeConnection",
      CompleteConnectionArgs,
      input,
      async (ctx, args) => {
        const result = await completeConnection(ctx, args);
        if (result.ok) await this.scheduleRefresh(ctx.tokens.nextRefreshAt());
        return result;
      },
    );
  }

  /** Renews the access token ahead of its expiry, then arms the next renewal. */
  async alarm(): Promise<void> {
    const tokens = this.tokensFor();
    if (tokens === null) return;
    const outcome = await tokens.refresh();
    if (outcome.kind === "ready") await this.scheduleRefresh(tokens.nextRefreshAt());
    // A refusal or a missing connection waits for a reconnect, which arms the alarm again.
    else if (outcome.kind === "retryable") {
      await this.scheduleRefresh(Date.now() + REFRESH_RETRY_DELAY_MS);
    }
  }

  /** Revokes the grant at TradeStation and deletes the stored credentials. */
  disconnect(input: unknown): Promise<EngineResult<{ revoked: boolean }>> {
    return this.enterWithConnection("disconnect", ModeOnlyArgs, input, async (ctx) => {
      const result = success(await disconnect(ctx));
      // forget() ran synchronously inside disconnect and a reconnect would have seeded a token, so
      // no token means no connection needs the alarm.
      if (ctx.tokens.nextRefreshAt() === null) await this.ctx.storage.deleteAlarm();
      return result;
    });
  }

  private enter<
    S extends Schema.Top & {
      readonly DecodingServices: never;
      readonly Type: { readonly mode: Mode };
    },
    T,
  >(
    method: string,
    schema: S,
    input: unknown,
    run: (args: S["Type"]) => EngineResult<T>,
  ): EngineResult<T> {
    const decoded = decodeArgs(schema, input);
    if (!decoded.ok) {
      // The input is never logged: it may carry anything the caller sent.
      this.log(
        "warn",
        decoded.code === "MODE_NOT_SIM" ? "REAL" : "SIM",
        `rpc.${decoded.code.toLowerCase()}`,
        method,
      );
      return failure(decoded.code);
    }
    return run(decoded.args);
  }

  /** Like enterWithConnection, with the broker this client trades through (SIM only). */
  private enterWithBroker<
    S extends Schema.Top & {
      readonly DecodingServices: never;
      readonly Type: { readonly mode: Mode };
    },
    T,
  >(
    method: string,
    schema: S,
    input: unknown,
    run: (ctx: EntryContext, args: S["Type"]) => Promise<EngineResult<T>>,
  ): Promise<EngineResult<T>> {
    return this.enterWithConnection(method, schema, input, (ctx, args) => {
      const broker = this.brokerFor(ctx);
      if (broker === null) return Promise.resolve(failure("BROKER_UNAVAILABLE"));
      return run({ ...ctx, broker }, args);
    });
  }

  /** One adapter per Durable Object, so the SIM account guard's cache is shared by its requests. */
  private brokerFor(ctx: ConnectionContext): BrokerAdapterShape | null {
    if (this.#broker !== null) return this.#broker;
    const resolved = resolveBroker({
      settings: this.env,
      userId: ctx.userId,
      now: () => Date.now(),
      accessToken: async () => {
        const access = await ctx.tokens.accessToken();
        return access.ok ? { ok: true, token: access.token } : { ok: false };
      },
    });
    if (!resolved.ok) {
      this.log("error", "SIM", "broker.unavailable", resolved.reason);
      return null;
    }
    this.#broker = resolved.broker;
    return this.#broker;
  }

  private async enterWithConnection<
    S extends Schema.Top & {
      readonly DecodingServices: never;
      readonly Type: { readonly mode: Mode };
    },
    T,
  >(
    method: string,
    schema: S,
    input: unknown,
    run: (ctx: ConnectionContext, args: S["Type"]) => Promise<EngineResult<T>>,
  ): Promise<EngineResult<T>> {
    const decoded = this.enter(method, schema, input, (args) => success(args));
    if (!decoded.ok) return decoded;
    // The Durable Object is named after the session user (engineFor); that name is the client id.
    const userId = this.ctx.id.name;
    const tokens = this.tokensFor();
    if (userId === undefined || tokens === null) return failure("INVALID_INPUT");
    try {
      return await run(
        {
          sql: this.ctx.storage.sql,
          storage: this.ctx.storage,
          db: this.env.DB,
          userId,
          now: Date.now(),
          cipher: () => createCipher(this.env.CREDENTIALS_KEY),
          tokens,
        },
        decoded.value,
      );
    } catch (error) {
      if (!(error instanceof CredentialsKeyError)) throw error;
      this.log("error", "SIM", "rpc.credentials_unavailable", method);
      return failure("CREDENTIALS_UNAVAILABLE");
    }
  }

  /** One refresher per Durable Object, so the client never has two refreshes in flight. */
  private tokensFor(): TokenRefresher | null {
    const userId = this.ctx.id.name;
    if (userId === undefined) return null;
    this.#tokens ??= new TokenRefresher({
      sql: this.ctx.storage.sql,
      storage: this.ctx.storage,
      db: this.env.DB,
      userId,
      cipher: () => createCipher(this.env.CREDENTIALS_KEY),
      clock: () => Date.now(),
      retryDelayMs: REFRESH_REQUEST_RETRY_DELAY_MS,
    });
    return this.#tokens;
  }

  private async scheduleRefresh(at: number | null): Promise<void> {
    if (at !== null) await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
  }

  private notImplemented(method: string): EngineResult<never> {
    this.log("info", "SIM", "rpc.not_implemented", method);
    return failure("NOT_IMPLEMENTED");
  }

  private log(level: "info" | "warn" | "error", mode: Mode, type: string, method: string): void {
    writeEvent(this.ctx.storage.sql, Date.now(), {
      mode,
      level,
      type,
      message: method,
      data: { method },
    });
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<EngineEnv>;
