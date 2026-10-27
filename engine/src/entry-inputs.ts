// What sizing a streamed entry needs from D1, held in the Durable Object so a tick of the entry
// symbol reads no database (D47). D1 stays the owner of these values: this is a read cache that is
// dropped by `invalidate()` on every event that changes them (a SIZE change from the admin screen,
// a daily entries limit change, a connection change) and, as a backstop for a missed call, expires after
// LIVE_ENTRY_INPUTS_TTL_MS. Only the live preview reads through it: sendEntry and the one-off
// prepareEntry call always read D1.

import { DEFAULT_DAILY_ENTRIES } from "#lib/domain/guards.ts";
import { readConnectionRow, type ConnectionContext, type ConnectionRow } from "./connection.ts";
import { timedD1 } from "./timing.ts";

export interface EntryInputs {
  /** Null when the client has no connection row. */
  readonly connection: ConnectionRow | null;
  /** Whole US dollars; null when the client has no settings row. */
  readonly sizeUsd: number | null;
  /** The client's daily entries limit (D48); the default when there is no settings row. */
  readonly maxDailyEntries: number;
}

type InputsContext = Pick<ConnectionContext, "db" | "userId">;

/** The connection row and the settings together; each is one D1 round trip. */
export async function loadEntryInputs(ctx: InputsContext): Promise<EntryInputs> {
  const [connection, settings] = await Promise.all([
    readConnectionRow(ctx),
    // The client's SIZE and daily limit, read from D1 where the admin sets them: the browser has no say.
    timedD1(
      "size_usd",
      ctx.db
        .prepare("SELECT size_usd, max_daily_entries FROM client_settings WHERE user_id = ?")
        .bind(ctx.userId)
        .first<{ size_usd: number; max_daily_entries: number }>(),
    ),
  ]);
  return {
    connection,
    sizeUsd: settings?.size_usd ?? null,
    maxDailyEntries: settings?.max_daily_entries ?? DEFAULT_DAILY_ENTRIES,
  };
}

export class EntryInputsCache {
  #held: { readonly inputs: EntryInputs; readonly readAt: number } | null = null;
  /** Bumped by every invalidation, so a read that started before it is not kept. */
  #version = 0;

  constructor(
    private readonly clock: () => number,
    private readonly ttlMs: number,
  ) {}

  invalidate(): void {
    this.#version += 1;
    this.#held = null;
  }

  async read(ctx: InputsContext): Promise<EntryInputs> {
    const held = this.#held;
    const age = held === null ? 0 : this.clock() - held.readAt;
    if (held !== null && age >= 0 && age < this.ttlMs) return held.inputs;
    const version = this.#version;
    const readAt = this.clock();
    const inputs = await loadEntryInputs(ctx);
    // A missing row is not kept: the next tick asks again, so a connect or a first SIZE shows at once.
    if (version === this.#version && inputs.connection !== null && inputs.sizeUsd !== null) {
      this.#held = { inputs, readAt };
    }
    return inputs;
  }
}
