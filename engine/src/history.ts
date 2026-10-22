// The client's own orders and events, newest first (docs/screens-and-flows.md, /historial). Only
// reads; it carries no P&L, balance or broker identifier, and the Durable Object is already the
// client, so there is no client id to filter by.

import { nextCalendarDay, startOfSessionDay } from "#lib/domain/calendar.ts";
import type { HistoryArgs } from "./rpc.ts";

export const HISTORY_PAGE_SIZE = 25;
const EVENTS_SHOWN = 50;

type IntentRow = {
  id: string;
  kind: string;
  account_id: string;
  symbol: string;
  asset_type: string;
  trade_action: string;
  qty: number;
  state: string;
  filled_qty: number;
  avg_fill_price: number | null;
  source: string;
  created_at: number;
  updated_at: number;
};

type EventRow = { at: number; level: string; type: string };

export interface HistoryPage {
  readonly mode: "SIM";
  readonly intents: readonly IntentRow[];
  /** Newest events of the client; sent with the first page only, narrowed by date alone. */
  readonly events: readonly EventRow[];
  readonly accounts: readonly string[];
  readonly nextCursor: string | null;
}

export function readHistory(sql: SqlStorage, args: HistoryArgs): HistoryPage {
  const intentWhere = ["mode = ?"];
  const intentParams: (string | number)[] = [args.mode];
  const eventWhere = ["mode = ?"];
  const eventParams: (string | number)[] = [args.mode];

  if (args.accountId !== undefined) {
    intentWhere.push("account_id = ?");
    intentParams.push(args.accountId);
  }
  if (args.symbol !== undefined) {
    intentWhere.push("symbol = ?");
    intentParams.push(args.symbol.toUpperCase());
  }
  if (args.state !== undefined) {
    intentWhere.push("state = ?");
    intentParams.push(args.state);
  }
  if (args.level !== undefined) {
    eventWhere.push("level = ?");
    eventParams.push(args.level);
  }
  if (args.from !== undefined) {
    const start = startOfSessionDay(args.from);
    intentWhere.push("created_at >= ?");
    intentParams.push(start);
    eventWhere.push("at >= ?");
    eventParams.push(start);
  }
  if (args.to !== undefined) {
    const end = startOfSessionDay(nextCalendarDay(args.to));
    intentWhere.push("created_at < ?");
    intentParams.push(end);
    eventWhere.push("at < ?");
    eventParams.push(end);
  }
  if (args.cursor !== undefined) {
    const [createdAt = "0", id = ""] = args.cursor.split(":");
    intentWhere.push("(created_at, id) < (?, ?)");
    intentParams.push(Number(createdAt), id);
  }

  const rows = sql
    .exec<IntentRow>(
      `SELECT id, kind, account_id, symbol, asset_type, trade_action, qty, state, filled_qty,
              avg_fill_price, source, created_at, updated_at
         FROM intents WHERE ${intentWhere.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...intentParams,
      HISTORY_PAGE_SIZE + 1,
    )
    .toArray();
  const intents = rows.slice(0, HISTORY_PAGE_SIZE);
  const last = intents.at(-1);

  // Internal detail (`data_json`, the message) never leaves the engine: the screen gets when,
  // how serious and which kind.
  const events =
    args.cursor !== undefined
      ? []
      : sql
          .exec<EventRow>(
            `SELECT at, level, type FROM events WHERE ${eventWhere.join(" AND ")}
               ORDER BY at DESC, id DESC LIMIT ?`,
            ...eventParams,
            EVENTS_SHOWN,
          )
          .toArray();

  const accounts = sql
    .exec<{ account_id: string }>(
      "SELECT DISTINCT account_id FROM intents WHERE mode = ? ORDER BY account_id",
      args.mode,
    )
    .toArray()
    .map((row) => row.account_id);

  return {
    mode: "SIM",
    intents,
    events,
    accounts,
    nextCursor:
      rows.length > HISTORY_PAGE_SIZE && last !== undefined
        ? `${last.created_at}:${last.id}`
        : null,
  };
}
