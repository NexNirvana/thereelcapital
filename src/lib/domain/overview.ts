// What the engine tells an admin about one client (docs/screens-and-flows.md, /admin/operativa).
// Plain data, read-only, shared by the engine that builds it and the web Worker that shows it. It
// carries no secret, token, broker order id, price or P&L.

import type { ConnectionHealth } from "./connection";

export type OverviewConnection =
  | { readonly status: "NOT_CONNECTED" }
  | {
      readonly status: "CONNECTED";
      readonly health: ConnectionHealth;
      readonly entriesBlocked: boolean;
      readonly accounts: ReadonlyArray<{
        readonly accountId: string;
        readonly accountType: "Cash" | "Margin";
      }>;
      /** null: unknown (rows stored before the connect-time expiry). */
      readonly refreshExpiresAt: number | null;
      readonly lastOkAt: number | null;
    };

export interface OverviewPosition {
  readonly id: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly originalQty: number;
  readonly soldQty: number;
  /** Stored as the engine wrote it: `none`, `unverified`, ... */
  readonly protectionState: string;
  readonly status: string;
}

/** An order that has not reached a final state; UNKNOWN ones are flagged by `state`. */
export interface OverviewOrder {
  readonly id: string;
  readonly kind: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly state: string;
  readonly qty: number;
  readonly filledQty: number;
  readonly createdAt: number;
}

export interface ClientOverview {
  readonly connection: OverviewConnection;
  readonly positionsOpen: number;
  readonly maxPositions: number;
  readonly entriesToday: number;
  readonly maxEntries: number;
  readonly positions: readonly OverviewPosition[];
  readonly orders: readonly OverviewOrder[];
}

/** What the admin screens show for a client's connection: the health, or why there is none. */
export type ConnectionKey =
  "NOT_CONNECTED" | "UNAVAILABLE" | "ok" | "expiring" | "expired" | "revoked" | "error";

/** `overview` is null when no object was asked (the client has never connected). */
export function connectionKey(
  overview:
    | { readonly status: "ok"; readonly value: ClientOverview }
    | { readonly status: "unavailable" }
    | null,
): ConnectionKey {
  if (overview === null) return "NOT_CONNECTED";
  if (overview.status === "unavailable") return "UNAVAILABLE";
  const { connection } = overview.value;
  return connection.status === "NOT_CONNECTED" ? "NOT_CONNECTED" : connection.health.status;
}
