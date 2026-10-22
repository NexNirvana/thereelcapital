// Decided parameter values (decisions D19 and D20, docs/product-spec.md#parameters).
// Percentages are whole numbers. Keep every undecided or tunable value here.

/** Trailing % the client may choose at activation. */
export const TRAILING_PCT_OPTIONS = [1, 5, 8, 10, 15, 20] as const;
export const DEFAULT_TRAILING_PCT = 10;

/** Initial SIZE per entry in US dollars; the admin may only increase it (docs/product-spec.md#parameters). */
export const DEFAULT_SIZE_USD = 20_000;

/** Initial stop % below the average fill price, set by the admin per client. */
export const STOP_PCT_BOUNDS = { min: 10, max: 50 } as const;
export const DEFAULT_STOP_PCT = 30;

/** Share of the original quantity that must be sold (confirmed) to unlock trailing. */
export const TRAILING_UNLOCK_PCT_BOUNDS = { min: 30, max: 90 } as const;
export const DEFAULT_TRAILING_UNLOCK_PCT = 70;

/** Recovery codes issued per set (issue #14). */
export const RECOVERY_CODE_COUNT = 10;

/** How long an enrollment session lasts (docs/auth-and-security.md#flows). */
export const ENROLLMENT_SESSION_MINUTES = 15;

/**
 * Redeeming a recovery code, per client IP: 5 attempts per 10 minutes (decision D28). Codes
 * carry about 124 bits of entropy, so this is defense in depth.
 */
export const RECOVERY_REDEEM_RATE_LIMIT = { windowSeconds: 600, max: 5 } as const;

/** How long an activation link works (docs/auth-and-security.md#flows). */
export const ACTIVATION_LINK_LIFETIME_HOURS = 72;
export const ACTIVATION_LINK_LIFETIME_MS = ACTIVATION_LINK_LIFETIME_HOURS * 60 * 60 * 1000;

/**
 * Opening an activation link, per client IP. 5 attempts per 10 minutes (decision D28): the
 * tokens carry 256 bits of entropy, so this is defense in depth.
 */
export const ACTIVATION_REDEEM_RATE_LIMIT = { windowSeconds: 600, max: 5 } as const;

/** Access tokens last 20 minutes; the engine refreshes this long before they run out. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Absolute lifetime of a rotating refresh token (docs/tradestation-integration.md#token-lifetime). */
export const ROTATING_REFRESH_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Decided (D33): how long before a known refresh expiry the client is warned. */
export const REFRESH_EXPIRY_WARNING_MS = 2 * 60 * 60 * 1000;

/** Wait before the engine tries again after a refresh failed for a reason that may pass. */
export const REFRESH_RETRY_DELAY_MS = 60 * 1000;

/** Wait before the sync loop tries again after a tick failed; decided equal to the refresh retry. */
export const SYNC_RETRY_DELAY_MS = 60 * 1000;

/** Pause between the attempts of one refresh request when TradeStation cannot be reached. */
export const REFRESH_REQUEST_RETRY_DELAY_MS = 500;

/** Decided (D33): pause between sync-loop ticks while anything is open or pending. */
export const SYNC_INTERVAL_MS = 5 * 1000;

/**
 * Undecided (docs/open-questions.md): a `sync` request (page load or poll) skips the broker read when
 * the last good pass is younger than this. Short enough that a screen is never visibly stale, long
 * enough to absorb a burst of page loads; the sync-loop tick is never throttled.
 */
export const SYNC_MIN_INTERVAL_MS = 2 * 1000;

/** Undecided: how long the engine reuses the protection settings it read from D1 (D1 stays their owner). */
export const PROTECTION_SETTINGS_TTL_MS = SYNC_INTERVAL_MS;

/** Decided (D22): events are kept 6 years, then the sync tick prunes them. */
export const EVENT_RETENTION_MS = 6 * 365 * 24 * 60 * 60 * 1000;

/**
 * Decided (D37): how long the engine-held stop (D36) waits before sending a new stop for a position
 * whose last stop the broker rejected. A new stop is a new order, never a resend of the rejected one.
 */
export const STOP_REJECTED_COOLDOWN_MS = 30 * 1000;

/**
 * Decided (D33): a SENT intent younger than this may still have its place request in flight, so the
 * sync loop leaves it alone; an older one with no order at the broker becomes UNKNOWN.
 */
export const SEND_GRACE_MS = 60 * 1000;

/** Decided (D33): clock difference tolerated when matching a broker order's open time to an intent. */
export const ORDER_MATCH_SKEW_MS = 60 * 1000;

/**
 * Decided (D33): how old an option chain snapshot may get before the screen
 * calls its prices out of date. The chain is read on demand, never polled.
 */
export const CHAIN_STALE_AFTER_MS = 30 * 1000;

/** Decided (D33): how long the admin overview waits for one client's Durable Object. */
export const ADMIN_FANOUT_TIMEOUT_MS = 4 * 1000;

/**
 * How a client's browser comes back from TradeStation (decision D35). "paste": the redirect goes
 * to a bare localhost URL that every key allows by default, which does not load, and the client
 * pastes that address into /conexion. "registered": the client registered our callback URL on
 * their key and TradeStation redirects to it.
 */
export const CONNECT_REDIRECT_MODE: "paste" | "registered" = "paste";

/** The `redirect_uri` of paste mode: one of TradeStation's default allowed callbacks, no path. */
export const PASTE_REDIRECT_URI = "http://localhost:3000";
