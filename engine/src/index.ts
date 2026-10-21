import { DurableObject } from "cloudflare:workers";
import { writeEvent } from "./events.ts";
import { migrate } from "./schema.ts";
import {
  ActivateTrailingArgs,
  CancelArgs,
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
  constructor(ctx: DurableObjectState, env: EngineEnv) {
    super(ctx, env);
    // Built before the first request is served, so every RPC sees the full schema.
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  ping(): string {
    return "pong";
  }

  // Trading methods: decoded and guarded now, implemented by the trading issues (M4 and M5).
  prepareEntry(input: unknown): EngineResult<never> {
    return this.enter("prepareEntry", PrepareEntryArgs, input, () =>
      this.notImplemented("prepareEntry"),
    );
  }

  sendEntry(input: unknown): EngineResult<never> {
    return this.enter("sendEntry", SendEntryArgs, input, () => this.notImplemented("sendEntry"));
  }

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

  /** The broker connection arrives with the TradeStation OAuth issue; until then it is never connected. */
  connection(input: unknown): EngineResult<{ mode: Mode; status: "NOT_CONNECTED" }> {
    return this.enter("connection", ModeOnlyArgs, input, ({ mode }) =>
      success({ mode, status: "NOT_CONNECTED" as const }),
    );
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
