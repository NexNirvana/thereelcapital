// TradeStation order status → intent state (docs/tradestation-integration.md#endpoints-used).
// The table is the documented mapping and nothing more: any other code is UNMAPPED, which means
// "keep the current intent state and log it" (docs/order-lifecycle.md).

import type { BrokerOrderStatus } from "../broker/adapter.ts";

const STATUS_MAP: Readonly<Record<string, BrokerOrderStatus>> = {
  ACK: "ACKNOWLEDGED",
  OPN: "ACKNOWLEDGED",
  DON: "ACKNOWLEDGED",
  FPR: "PARTIAL",
  FLL: "FILLED",
  FLP: "FILLED",
  CAN: "CANCELED",
  EXP: "CANCELED",
  UCH: "CANCELED",
  TSC: "CANCELED",
  OUT: "CANCELED",
  REJ: "REJECTED",
};

export function mapOrderStatus(rawStatus: string): BrokerOrderStatus | "UNMAPPED" {
  return Object.hasOwn(STATUS_MAP, rawStatus) ? (STATUS_MAP[rawStatus] ?? "UNMAPPED") : "UNMAPPED";
}
