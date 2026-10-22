/** Every order-lifecycle state, in lifecycle order (docs/order-lifecycle.md). */
export const ORDER_STATES = [
  "ARMED",
  "SENT",
  "ACKNOWLEDGED",
  "PARTIAL",
  "FILLED",
  "CANCEL_PENDING",
  "CANCELED",
  "REJECTED",
  "UNKNOWN",
] as const;
