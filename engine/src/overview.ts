// The admin's read-only view of this client (docs/screens-and-flows.md, /admin/operativa). It
// reads and returns plain data: no order is placed, cancelled or changed, and nothing it returns
// is a secret, token or broker order id.
import { Option, Schema } from "effect";
import type {
  ClientOverview,
  OverviewOrder,
  OverviewPosition,
  RealListing,
} from "#lib/domain/overview.ts";
import { readConnection, type ConnectionContext } from "./connection.ts";
import { entryLimits } from "./entries.ts";
import { loadEntryInputs } from "./entry-inputs.ts";
import { REAL_ACCOUNTS_LISTED } from "./real-accounts.ts";

type PositionRow = {
  id: string;
  account_id: string;
  symbol: string;
  original_qty: number;
  sold_qty: number;
  protection_state: string;
  status: string;
};
type OrderRow = {
  id: string;
  kind: string;
  account_id: string;
  symbol: string;
  state: string;
  qty: number;
  filled_qty: number;
  created_at: number;
};

const ListingData = Schema.fromJsonString(
  Schema.Struct({ stored: Schema.Number, skipped: Schema.Number }),
);

/** The newest REAL listing event through `events_by_mode_at`; null before the first one. */
export function readRealListing(sql: SqlStorage): RealListing | null {
  const row = sql
    .exec<{ at: number; data_json: string | null }>(
      "SELECT at, data_json FROM events WHERE mode = 'REAL' AND type = ? ORDER BY at DESC, id DESC LIMIT 1",
      REAL_ACCOUNTS_LISTED,
    )
    .toArray()[0];
  if (row === undefined || row.data_json === null) return null;
  const data = Schema.decodeUnknownOption(ListingData)(row.data_json);
  return Option.isSome(data) ? { at: row.at, ...data.value } : null;
}

export async function readOverview(ctx: ConnectionContext): Promise<ClientOverview> {
  const connection = await readConnection(ctx);
  // The client's own daily limit, from D1 where the admin sets it (D48).
  const { maxDailyEntries } = await loadEntryInputs(ctx);
  const limits = entryLimits(ctx, maxDailyEntries);
  const positions: OverviewPosition[] = ctx.sql
    .exec<PositionRow>(
      `SELECT id, account_id, symbol, original_qty, sold_qty, protection_state, status
         FROM positions WHERE mode = ? AND status != 'CLOSED' ORDER BY opened_on, symbol`,
      ctx.mode,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      accountId: row.account_id,
      symbol: row.symbol,
      originalQty: row.original_qty,
      soldQty: row.sold_qty,
      protectionState: row.protection_state,
      status: row.status,
    }));
  const orders: OverviewOrder[] = ctx.sql
    .exec<OrderRow>(
      `SELECT id, kind, account_id, symbol, state, qty, filled_qty, created_at FROM intents
         WHERE mode = ? AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')
         ORDER BY created_at DESC, id`,
      ctx.mode,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      accountId: row.account_id,
      symbol: row.symbol,
      state: row.state,
      qty: row.qty,
      filledQty: row.filled_qty,
      createdAt: row.created_at,
    }));
  return {
    connection:
      connection.status === "NOT_CONNECTED"
        ? { status: "NOT_CONNECTED" }
        : {
            status: "CONNECTED",
            health: connection.health,
            entriesBlocked: connection.entriesBlocked,
            accounts: connection.accounts,
            refreshExpiresAt: connection.refreshExpiresAt,
            lastOkAt: connection.lastOkAt,
          },
    positionsOpen: limits.positions,
    maxPositions: limits.maxPositions,
    entriesToday: limits.entriesToday,
    maxEntries: limits.maxEntries,
    positions,
    orders,
    realListing: ctx.mode === "REAL" ? readRealListing(ctx.sql) : null,
  };
}
