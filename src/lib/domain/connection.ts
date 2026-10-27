// Health of a client's TradeStation connection and what it allows.
// docs/tradestation-integration.md#token-lifetime, docs/order-lifecycle.md (failure table).
// Pure: the engine reads storage and the clock and passes the facts in.

import { REFRESH_EXPIRY_WARNING_MS } from "./config";

/** What the engine records after a refresh attempt; `CONNECTED` also covers "not tried yet". */
export type StoredConnectionState = "CONNECTED" | "EXPIRED" | "REVOKED" | "ERROR";

export type ConnectionHealth =
  | { readonly status: "ok" }
  /** The refresh token is known to expire at `refreshExpiresAt` (epoch ms), soon. */
  | { readonly status: "expiring"; readonly refreshExpiresAt: number }
  | { readonly status: "expired" }
  | { readonly status: "revoked" }
  /** TradeStation could not be reached or answered something unusable; may pass by itself. */
  | { readonly status: "error" };

export function connectionHealth(args: {
  readonly stored: StoredConnectionState;
  /** null means unknown or non-expiring: the normal state of a key that has not rotated (D44). */
  readonly refreshExpiresAt: number | null;
  readonly now: number;
}): ConnectionHealth {
  switch (args.stored) {
    case "EXPIRED":
      return { status: "expired" };
    case "REVOKED":
      return { status: "revoked" };
    case "ERROR":
      return { status: "error" };
    case "CONNECTED": {
      const { refreshExpiresAt, now } = args;
      if (refreshExpiresAt === null) return { status: "ok" };
      if (refreshExpiresAt <= now) return { status: "expired" };
      return refreshExpiresAt - now <= REFRESH_EXPIRY_WARNING_MS
        ? { status: "expiring", refreshExpiresAt }
        : { status: "ok" };
    }
  }
}

/** `ok` and `expiring` can still reach the broker; the others cannot. */
export function brokerReachable(health: ConnectionHealth): boolean {
  return health.status === "ok" || health.status === "expiring";
}

export type EntryBlock = "CONNECTION_UNUSABLE" | "RECONCILIATION_PENDING";

/**
 * Entries only; exits and cancels are never blocked by limits (CLAUDE.md rule 7), and when the
 * connection is down they cannot reach the broker anyway. A failure leaves `reconciliationPending`
 * set, so reconnecting alone does not reopen entries: the orders and positions are re-read first.
 */
export function entryBlock(args: {
  readonly health: ConnectionHealth;
  readonly reconciliationPending: boolean;
}): EntryBlock | null {
  if (!brokerReachable(args.health)) return "CONNECTION_UNUSABLE";
  return args.reconciliationPending ? "RECONCILIATION_PENDING" : null;
}
