// Decided parameter values (decisions D19 and D20, docs/product-spec.md#parameters).
// Percentages are whole numbers. Keep every undecided or tunable value here.

/** Trailing % the client may choose at activation. */
export const TRAILING_PCT_OPTIONS = [1, 5, 8, 10, 15, 20] as const;
export const DEFAULT_TRAILING_PCT = 10;

/** Initial SIZE per entry in US dollars; the admin may only increase it (docs/product-spec.md#parameters). */
export const DEFAULT_SIZE_USD = 20_000;

/**
 * Share of the client's SIZE an entry is sized at when the client picks «−25%» on Nueva entrada
 * (decision D51, docs/product-spec.md#parameters). Whole percent of the SIZE; per entry only.
 */
export const SIZE_DOWN_APPLIED_PCT = 75;

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

/**
 * How long a browser may keep using the signed session copy in its cookie before Better Auth
 * reads D1 again (decision D43). A ban, role change or revocation reaches a browser that holds a
 * cached copy within this time, on reads only; mutating requests always read D1.
 */
export const SESSION_COOKIE_CACHE_SECONDS = 30;

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

/**
 * UNDECIDED (docs/open-questions.md): how many consecutive refused refreshes (4xx) a connection
 * survives before it is marked REVOKED. The wait before each retry doubles from
 * REFRESH_RETRY_DELAY_MS, so 5 attempts span about 15 minutes. A refusal may be transient when an API
 * key is shared by several clients.
 */
export const REFRESH_REJECTIONS_BEFORE_REVOKED = 5;

/** Wait before the sync loop tries again after a tick failed; decided equal to the refresh retry. */
export const SYNC_RETRY_DELAY_MS = 60 * 1000;

/** Pause between the attempts of one refresh request when TradeStation cannot be reached. */
export const REFRESH_REQUEST_RETRY_DELAY_MS = 500;

/** Decided (D33): pause between sync-loop ticks while anything is open or pending. */
export const SYNC_INTERVAL_MS = 5 * 1000;

/**
 * Decided (D40): a `sync` request (page load or poll) skips the broker read when
 * the last good pass is younger than this. Short enough that a screen is never visibly stale, long
 * enough to absorb a burst of page loads; the sync-loop tick is never throttled.
 */
export const SYNC_MIN_INTERVAL_MS = 2 * 1000;

/** Decided (D40): how long the engine reuses the protection settings it read from D1 (D1 stays their owner). */
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
 * calls its prices out of date. While the screen is open the chain is read again at the live
 * pace (D46), so this only shows when the polling stopped or keeps failing.
 */
export const CHAIN_STALE_AFTER_MS = 30 * 1000;

/**
 * Decided (D46): how the screens keep a quote live. The prices are display only; the order is
 * always sized from a fresh ask when it is sent. A poll every `LIVE_QUOTE_POLL_MS` while the tab
 * is visible, at most `LIVE_QUOTE_MAX_POLLS` in a row (20 min at the base pace), slower after a
 * failure (doubling up to `LIVE_QUOTE_MAX_BACKOFF_MS`, which also protects the quotes budget of
 * 500 requests / 5 min), and a price older than `LIVE_QUOTE_STALE_AFTER_MS` is called out of date.
 */
export const LIVE_QUOTE_POLL_MS = 2 * 1000;
export const LIVE_QUOTE_MAX_POLLS = 600;
export const LIVE_QUOTE_MAX_BACKOFF_MS = 16 * 1000;
export const LIVE_QUOTE_STALE_AFTER_MS = 10 * 1000;

/**
 * Decided (D46): how long the engine keeps the strikes of an expiration it listed for the chain
 * screen, so the live refresh reads only the quotes (the options bucket allows 90 requests / min).
 */
export const CHAIN_STRIKES_CACHE_MS = 10 * 60 * 1000;

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

/**
 * Decided (D45): an option still open on its expiration day is sold at MARKET this long before that
 * day's regular-session close (15:45 ET on a normal day, 12:45 ET on an early-close day).
 */
export const EXPIRY_CLOSE_LEAD_MS = 15 * 60 * 1000;

/**
 * Decided (D47): the live quote stream. The upstream streams of a client carry the symbols of
 * every open screen. The numbers below are ours, not the broker's: the per-stream symbol limit and
 * the concurrent-stream limit are not stated in the specification we could read (verify on SIM).
 * A union beyond `LIVE_STREAM_MAX_SYMBOLS` is spread over several upstream streams, at most
 * `LIVE_STREAM_MAX_STREAMS` per client (500 symbols); a screen asking for more than that, or a
 * seventh socket, is simply left on snapshot polling. The upstream stream is restarted with a doubling delay after a failure
 * (`LIVE_STREAM_BACKOFF_*`); a socket is closed after `LIVE_STREAM_SOCKET_MAX_MS` and the page
 * opens a new one, which checks the session again. The page falls back to polling when nothing
 * arrived on the socket for `LIVE_STREAM_SILENCE_MS` (the broker's heartbeat, forwarded, is every
 * 5 s when idle: verify).
 */
export const LIVE_STREAM_MAX_SYMBOLS = 100;
export const LIVE_STREAM_MAX_STREAMS = 5;
export const LIVE_STREAM_MAX_SOCKETS = 6;
export const LIVE_STREAM_BACKOFF_BASE_MS = 1000;
export const LIVE_STREAM_BACKOFF_MAX_MS = 30 * 1000;
export const LIVE_STREAM_SOCKET_MAX_MS = 15 * 60 * 1000;
export const LIVE_STREAM_SILENCE_MS = 8 * 1000;

/**
 * How long the engine keeps the connection status and SIZE it read from D1 to size the streamed
 * entry (D47). D1 stays their owner: a SIZE change, a connection change and a reconnect drop the
 * copy at once, and this only bounds how long a missed drop (a failed call from the admin
 * screen) can show a stale quantity. Orders never use it. Ours, not TradeStation's.
 */
export const LIVE_ENTRY_INPUTS_TTL_MS = 60 * 1000;
/**
 * After a failed sizing of the streamed entry (the symbol details read failed or the symbol was
 * rejected), ticks of that symbol are not sized again for this long, so a failure costs one
 * broker call and one event row per interval instead of one per tick. Ours, not TradeStation's.
 */
export const LIVE_ENTRY_RETRY_MS = 5 * 1000;
/**
 * A stream that delivers nothing, not even a heartbeat, for this long is treated as broken and
 * restarted. (verify) The heartbeat interval is documented as 5 s; this leaves room for six.
 */
export const LIVE_STREAM_IDLE_MS = 30 * 1000;
/**
 * While a chain is on the stream, it is still read whole this many times slower than the poll: a
 * contract that had no market when the chain opened is not watched, and this read brings it in (D47).
 */
export const LIVE_CHAIN_REFRESH_FACTOR = 15;
