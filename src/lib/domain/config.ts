// Decided parameter values (decisions D19 and D20, docs/product-spec.md#parameters).
// Percentages are whole numbers. Keep every undecided or tunable value here.

/** Trailing % the client may choose at activation. */
export const TRAILING_PCT_OPTIONS = [1, 5, 8, 10, 15, 20] as const;
export const DEFAULT_TRAILING_PCT = 10;

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
 * Redeeming a recovery code, per client IP. Not in the docs yet: a provisional value kept here
 * until the owner decides. Codes carry about 124 bits of entropy, so this is defense in depth.
 */
export const RECOVERY_REDEEM_RATE_LIMIT = { windowSeconds: 600, max: 5 } as const;
