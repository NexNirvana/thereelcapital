// Typed failures every BrokerAdapter operation can return (docs/tradestation-integration.md,
// docs/order-lifecycle.md). Adapters map transport and HTTP outcomes onto these and nothing else.

import { Data } from "effect";

export type BrokerOperation =
  | "accounts"
  | "symbolDetails"
  | "quotes"
  | "quoteStream"
  | "optionExpirations"
  | "optionStrikes"
  | "chainSnapshot"
  | "confirmOrder"
  | "placeOrder"
  | "cancelOrder"
  | "orders"
  | "historicalOrders"
  | "positions";

/** The access token is expired or revoked (HTTP 401); refreshing it is the caller's job. */
export class AuthExpired extends Data.TaggedError("AuthExpired")<{
  readonly operation: BrokerOperation;
}> {}

/** The `X-RateLimit-*` headers of a response (docs: `Reset` is seconds until the limit resets). */
export interface RateLimitInfo {
  readonly resource: string | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly periodSeconds: number | null;
  readonly resetMs: number | null;
}

/** HTTP 429. `retryAfterMs` is null when the broker gave no hint; `rateLimit` carries the headers when it did. */
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly operation: BrokerOperation;
  readonly retryAfterMs: number | null;
  readonly rateLimit?: RateLimitInfo | undefined;
}> {}

/** The broker understood the request and refused it. `code` is stable, `reason` is for the event log. */
export class Rejected extends Data.TaggedError("Rejected")<{
  readonly operation: BrokerOperation;
  readonly code: string;
  readonly reason: string;
}> {}

/**
 * No answer in time. For place and cancel the request may or may not have taken effect, so the
 * caller marks the intent UNKNOWN and reconciles; it never resends (order-lifecycle.md, rule 2).
 */
export class Timeout extends Data.TaggedError("Timeout")<{
  readonly operation: BrokerOperation;
}> {}

/** Anything else: an undecodable response, a 5xx, a dropped connection. Treated like a Timeout for orders. */
export class Unknown extends Data.TaggedError("Unknown")<{
  readonly operation: BrokerOperation;
  readonly detail: string;
}> {}

export type BrokerError = AuthExpired | RateLimited | Rejected | Timeout | Unknown;
