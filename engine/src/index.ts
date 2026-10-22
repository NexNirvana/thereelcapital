import { DurableObject } from "cloudflare:workers";
import {
  beginConnection,
  completeConnection,
  disconnect,
  readConnection,
  type ConnectionContext,
  type ConnectionView,
} from "./connection.ts";
import {
  REFRESH_REQUEST_RETRY_DELAY_MS,
  REFRESH_RETRY_DELAY_MS,
  SYNC_RETRY_DELAY_MS,
  SYNC_INTERVAL_MS,
} from "#lib/domain/config.ts";
import { createCipher, CredentialsKeyError } from "./crypto.ts";
import { TokenRefresher } from "./refresh.ts";
import { AlarmScheduler, type AlarmTask } from "./scheduler.ts";
import { runSync, syncWanted, type SyncContext, type SyncResult } from "./sync.ts";
import { resolveBroker } from "./broker/provider.ts";
import type { BrokerAdapterShape } from "./broker/adapter.ts";
import { engineNow, syncDelayMs } from "./clock.ts";
import {
  entryLimits,
  prepareEntry,
  sendEntry,
  type EntryLimits,
  type EntryContext,
  type PrepareEntryResult,
  type SendEntryResult,
} from "./entries.ts";
import {
  optionChain,
  optionContract,
  optionExpirations,
  type OptionChain,
  type OptionContractView,
} from "./chain.ts";
import { writeEvent } from "./events.ts";
import { cancelIntent, exitPosition, type CancelResult, type ExitResult } from "./exits.ts";
import { activateTrailing, type TrailingResult } from "./trailing.ts";
import { readOverview } from "./overview.ts";
import { readPositionsView } from "./positions-view.ts";
import { readHistory, type HistoryPage } from "./history.ts";
import { migrate } from "./schema.ts";
import { seedForTest, type SeedResult } from "./test-seed.ts";
import {
  ActivateTrailingArgs,
  BeginConnectionArgs,
  CancelArgs,
  CompleteConnectionArgs,
  decodeArgs,
  ExitArgs,
  failure,
  HistoryArgs,
  ModeOnlyArgs,
  OptionChainArgs,
  OptionContractArgs,
  OptionExpirationsArgs,
  PrepareEntryArgs,
  SendEntryArgs,
  success,
  type EngineResult,
} from "./rpc.ts";
import type { ClientOverview } from "#lib/domain/overview.ts";
import type { PositionsView } from "#lib/domain/positions-view.ts";
import type { Schema } from "effect";
import type { Mode } from "./mode.ts";

/** The `_tag` of a typed error, or "unknown": enough to tell failures apart without their detail. */
function errorTag(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
    ? error._tag
    : "unknown";
}

const ALARM_RETRY_DELAY_MS = {
  refresh: REFRESH_RETRY_DELAY_MS,
  sync: SYNC_RETRY_DELAY_MS,
} as const satisfies Record<AlarmTask, number>;

type Row = Record<string, SqlStorageValue>;

/**
 * One instance per client, addressed by user id; it only ever knows its own client. Every public
 * method takes `unknown`, decodes it, and rejects anything but SIM before touching storage
 * (`ping` and the test-only `seedForTest` excepted: the latter is refused outside development/test).
 */
export class ClientCoordinator extends DurableObject<EngineEnv> {
  #tokens: TokenRefresher | null = null;
  #broker: BrokerAdapterShape | null = null;
  readonly #alarms: AlarmScheduler;
  /** A pass already running is shared, so two never apply snapshots out of order. */
  #syncing: Promise<SyncResult> | null = null;

  constructor(ctx: DurableObjectState, env: EngineEnv) {
    super(ctx, env);
    this.#alarms = new AlarmScheduler(ctx.storage, () => this.#now());
    // Built before the first request is served, so every RPC sees the full schema.
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage);
      // The Durable Object (re)started: reconcile at once if anything is open or pending.
      if (syncWanted(ctx.storage)) await this.#alarms.scheduleNoLater("sync", this.#now());
    });
  }

  /**
   * The wall clock of everything scheduled: alarm due times, retries, token expiry and event
   * stamps. It is deliberately not `engineNow`: a pinned TEST_NOW never advances, so alarm times
   * built on it would never come due and would stall the sync loop (clock.ts).
   */
  #now(): number {
    return Date.now();
  }

  ping(): string {
    return "pong";
  }

  /** Test-only: writes fixture rows from inside the object. Refused outside development/test. */
  seedForTest(statements: unknown): SeedResult {
    return seedForTest(this.env.ENVIRONMENT, this.ctx.storage, statements);
  }

  /** A sized, guarded preview of an entry. Creates no intent and reserves nothing. */
  prepareEntry(input: unknown): Promise<EngineResult<PrepareEntryResult>> {
    return this.enterWithBroker("prepareEntry", PrepareEntryArgs, input, prepareEntry);
  }

  /** Reserves, persists the intent, then places the MARKET order once. */
  sendEntry(input: unknown): Promise<EngineResult<SendEntryResult>> {
    return this.enterWithBroker("sendEntry", SendEntryArgs, input, async (ctx, args) => {
      const result = await sendEntry(ctx, args);
      // A placed entry is something to watch: start the loop if it is not running.
      if (result.ok && result.value.status === "PLACED") {
        await this.#alarms.scheduleNoLater(
          "sync",
          this.#now() + syncDelayMs(this.env, SYNC_INTERVAL_MS),
        );
      }
      return result;
    });
  }

  /**
   * Reads the broker and reconciles (a client opened the app), unless a good pass ran within
   * `SYNC_MIN_INTERVAL_MS` and nothing is pending. Safe to call at any time.
   */
  sync(input: unknown): Promise<EngineResult<{ reconciled: boolean }>> {
    return this.enterWithBroker("sync", ModeOnlyArgs, input, async (ctx) => {
      const result = await this.syncOnce(ctx, { throttle: true });
      // Work this pass found or left keeps the loop going even if it had stopped.
      if (result.nextInMs !== null) {
        await this.#alarms.scheduleNoLater(
          "sync",
          this.#now() + syncDelayMs(this.env, result.nextInMs),
        );
      }
      return success({ reconciled: result.reconciled });
    });
  }

  /** The counts behind «x/2 posiciones · y/3 entradas hoy». Read-only. */
  limits(input: unknown): EngineResult<EntryLimits> {
    return this.enter("limits", ModeOnlyArgs, input, () =>
      success(entryLimits({ sql: this.ctx.storage.sql, now: engineNow(this.env) })),
    );
  }

  /** Expiration dates of an underlying's options. Read-only. */
  optionExpirations(
    input: unknown,
  ): Promise<EngineResult<{ underlying: string; expirations: ReadonlyArray<string> }>> {
    return this.enterWithBroker(
      "optionExpirations",
      OptionExpirationsArgs,
      input,
      optionExpirations,
    );
  }

  /** One snapshot of an expiration's chain, read on demand and closed. Read-only. */
  optionChain(input: unknown): Promise<EngineResult<OptionChain>> {
    return this.enterWithBroker("optionChain", OptionChainArgs, input, (ctx, args) =>
      optionChain({ ...ctx, stamp: () => engineNow(this.env) }, args),
    );
  }

  /** The underlying, expiration, strike and right behind an option symbol. Read-only. */
  optionContract(input: unknown): Promise<EngineResult<OptionContractView>> {
    return this.enterWithBroker("optionContract", OptionContractArgs, input, (ctx, args) =>
      optionContract(ctx, args),
    );
  }

  // Trading methods still to come: decoded and guarded now, implemented by the trading issues.

  /** A scale-out step or ALL OUT: the quantity comes from the sell ledger, the order is placed once. */
  exit(input: unknown): Promise<EngineResult<ExitResult>> {
    return this.enterWithBroker("exit", ExitArgs, input, async (ctx, args) => {
      const result = await exitPosition(ctx, args);
      if (result.ok && result.value.status === "PLACED") {
        // The loop watches the fill; it must be running while an exit is pending.
        await this.#alarms.scheduleNoLater(
          "sync",
          this.#now() + syncDelayMs(this.env, SYNC_INTERVAL_MS),
        );
      }
      return result;
    });
  }

  /** CANCEL_PENDING until the broker confirms; the sync loop applies its answer. */
  cancel(input: unknown): Promise<EngineResult<CancelResult>> {
    return this.enterWithBroker("cancel", CancelArgs, input, async (ctx, args) => {
      const result = await cancelIntent(ctx, args);
      if (result.ok && result.value.status === "REQUESTED") {
        await this.#alarms.scheduleNoLater(
          "sync",
          this.#now() + syncDelayMs(this.env, SYNC_INTERVAL_MS),
        );
      }
      return result;
    });
  }

  /** Manual trailing activation; the monitor in the sync loop then follows the bid. */
  activateTrailing(input: unknown): Promise<EngineResult<TrailingResult>> {
    return this.enterWithBroker("activateTrailing", ActivateTrailingArgs, input, activateTrailing);
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

  /** Open positions with their steps and the exit orders still working, for /posiciones. Read-only. */
  positions(input: unknown): EngineResult<PositionsView> {
    return this.enter("positions", ModeOnlyArgs, input, () =>
      success(readPositionsView(this.ctx.storage.sql, engineNow(this.env))),
    );
  }

  /** Orders (newest first, one page) and events of this client. Read-only; no P&L. */
  history(input: unknown): EngineResult<HistoryPage> {
    return this.enter("history", HistoryArgs, input, (args) =>
      success(readHistory(this.ctx.storage.sql, args)),
    );
  }

  /** Status of the client's TradeStation connection and the accounts it can trade. */
  connection(input: unknown): Promise<EngineResult<ConnectionView>> {
    return this.enterWithConnection("connection", ModeOnlyArgs, input, async (ctx) =>
      success(await readConnection(ctx)),
    );
  }

  /** Connection, open positions, unfinished orders and the day's counts, for the admin. Read-only. */
  overview(input: unknown): Promise<EngineResult<ClientOverview>> {
    return this.enterWithConnection("overview", ModeOnlyArgs, input, async (ctx) =>
      success(await readOverview(ctx)),
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
        if (result.ok) {
          await this.scheduleRefresh(ctx.tokens.nextRefreshAt());
          // Orders may have moved while we were not connected: reconcile before anything else.
          // One tick from now, so the first read does not race the connection settling.
          await this.#alarms.scheduleNoLater(
            "sync",
            this.#now() + syncDelayMs(this.env, SYNC_INTERVAL_MS),
          );
        }
        return result;
      },
    );
  }

  /**
   * The one alarm serves every scheduled job (scheduler.ts): each job that is due runs and
   * reschedules itself, then the alarm is armed for the earliest remaining time.
   */
  async alarm(): Promise<void> {
    for (const task of this.#alarms.due(this.#now())) {
      const scheduledFor = this.#alarms.dueAt(task);
      try {
        await this.runTask(task);
      } catch (error) {
        // Retry later instead of rethrowing: a throw would re-run the other jobs as well.
        this.log("error", "SIM", "alarm.task_failed", task, errorTag(error));
        await this.#alarms.schedule(task, this.#now() + ALARM_RETRY_DELAY_MS[task]);
        continue;
      }
      // A job that did not reschedule itself is finished; leaving it due would re-fire at once.
      if (this.#alarms.dueAt(task) === scheduledFor) await this.#alarms.schedule(task, null);
    }
    await this.#alarms.arm();
  }

  /** Refresh renews the access token ahead of its expiry, then arms the next renewal. */
  private async runTask(task: AlarmTask): Promise<void> {
    switch (task) {
      case "refresh": {
        const tokens = this.tokensFor();
        if (tokens === null) return;
        const outcome = await tokens.refresh();
        if (outcome.kind === "ready") await this.scheduleRefresh(tokens.nextRefreshAt());
        // A refusal or a missing connection waits for a reconnect, which arms the alarm again.
        else if (outcome.kind === "retryable") {
          await this.scheduleRefresh(this.#now() + REFRESH_RETRY_DELAY_MS);
        }
        return;
      }
      case "sync": {
        const ctx = this.connectionContext();
        const broker = ctx === null ? null : this.brokerFor(ctx);
        if (ctx === null || broker === null) return;
        const result = await this.syncOnce({ ...ctx, broker });
        await this.#alarms.schedule(
          "sync",
          result.nextInMs === null ? null : this.#now() + syncDelayMs(this.env, result.nextInMs),
        );
        return;
      }
    }
  }

  private syncOnce(
    ctx: SyncContext,
    options?: { readonly throttle?: boolean },
  ): Promise<SyncResult> {
    this.#syncing ??= runSync({ ...ctx, wallNow: () => this.#now() }, options).finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  /** Revokes the grant at TradeStation and deletes the stored credentials. */
  disconnect(input: unknown): Promise<EngineResult<{ revoked: boolean }>> {
    return this.enterWithConnection("disconnect", ModeOnlyArgs, input, async (ctx) => {
      const result = success(await disconnect(ctx));
      // forget() ran synchronously inside disconnect and a reconnect would have seeded a token, so
      // no token means no connection needs the alarm.
      if (ctx.tokens.nextRefreshAt() === null) {
        await this.#alarms.schedule("refresh", null);
        // Nothing to read with, so nothing to sync until a reconnect.
        await this.#alarms.schedule("sync", null);
      }
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
      now: () => this.#now(),
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
    const context = this.connectionContext();
    if (context === null) return failure("INVALID_INPUT");
    try {
      return await run(context, decoded.value);
    } catch (error) {
      if (!(error instanceof CredentialsKeyError)) throw error;
      this.log("error", "SIM", "rpc.credentials_unavailable", method);
      return failure("CREDENTIALS_UNAVAILABLE");
    }
  }

  /** The Durable Object is named after the session user (engineFor); that name is the client id. */
  private connectionContext(): ConnectionContext | null {
    const userId = this.ctx.id.name;
    const tokens = this.tokensFor();
    if (userId === undefined || tokens === null) return null;
    return {
      sql: this.ctx.storage.sql,
      storage: this.ctx.storage,
      db: this.env.DB,
      userId,
      now: engineNow(this.env),
      cipher: () => createCipher(this.env.CREDENTIALS_KEY, this.env.CREDENTIALS_KEY_PREVIOUS),
      tokens,
    };
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
      cipher: () => createCipher(this.env.CREDENTIALS_KEY, this.env.CREDENTIALS_KEY_PREVIOUS),
      clock: () => this.#now(),
      retryDelayMs: REFRESH_REQUEST_RETRY_DELAY_MS,
    });
    return this.#tokens;
  }

  private async scheduleRefresh(at: number | null): Promise<void> {
    if (at !== null) await this.#alarms.schedule("refresh", at);
  }

  private log(
    level: "info" | "warn" | "error",
    mode: Mode,
    type: string,
    method: string,
    failure?: string,
  ): void {
    writeEvent(this.ctx.storage.sql, this.#now(), {
      mode,
      level,
      type,
      message: method,
      data: failure === undefined ? { method } : { method, failure },
    });
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<EngineEnv>;
