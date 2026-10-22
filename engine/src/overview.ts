// The admin's read-only view of this client (docs/screens-and-flows.md, /admin/operativa). It
// reads and returns plain data: no order is placed, cancelled or changed, and nothing it returns
// is a secret, token or broker order id.
import type { ClientOverview, OverviewOrder, OverviewPosition } from "#lib/domain/overview.ts";
import { readConnection, type ConnectionContext } from "./connection.ts";
import { entryLimits } from "./entries.ts";

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

export async function readOverview(ctx: ConnectionContext): Promise<ClientOverview> {
  const connection = await readConnection(ctx);
  const limits = entryLimits(ctx);
  const positions: OverviewPosition[] = ctx.sql
    .exec<PositionRow>(
      `SELECT id, account_id, symbol, original_qty, sold_qty, protection_state, status
         FROM positions WHERE mode = 'SIM' AND status != 'CLOSED' ORDER BY opened_on, symbol`,
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
         WHERE mode = 'SIM' AND state NOT IN ('FILLED', 'CANCELED', 'REJECTED')
         ORDER BY created_at DESC, id`,
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
  };
}
