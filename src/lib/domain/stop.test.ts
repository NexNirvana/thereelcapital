import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STOP_PCT,
  DEFAULT_TRAILING_PCT,
  DEFAULT_TRAILING_UNLOCK_PCT,
  TRAILING_PCT_OPTIONS,
} from "./config";
import { parseMicros } from "./money";
import {
  activateTrailing,
  nextTrailing,
  shouldExit,
  stopLevel,
  trailingEligible,
  validateStopPct,
  validateTrailingPct,
  validateTrailingUnlockPct,
} from "./stop";

const usd = parseMicros;

describe("decided defaults", () => {
  test("pass their own validation", () => {
    expect(validateStopPct(DEFAULT_STOP_PCT).ok).toBe(true);
    expect(validateTrailingUnlockPct(DEFAULT_TRAILING_UNLOCK_PCT).ok).toBe(true);
    expect(validateTrailingPct(DEFAULT_TRAILING_PCT).ok).toBe(true);
  });
});

describe("parameter validation", () => {
  test("accepts the stop bounds and rejects values outside or fractional", () => {
    for (const pct of [10, 30, 50]) expect(validateStopPct(pct).ok).toBe(true);
    for (const pct of [9, 51, 0, -30, 30.5, Number.NaN]) {
      expect(validateStopPct(pct)).toEqual({ ok: false, reason: "STOP_PCT_OUT_OF_BOUNDS" });
    }
  });

  test("accepts the unlock bounds and rejects values outside or fractional", () => {
    for (const pct of [30, 70, 90]) expect(validateTrailingUnlockPct(pct).ok).toBe(true);
    for (const pct of [29, 91, 100, 70.5, Number.NaN]) {
      expect(validateTrailingUnlockPct(pct)).toEqual({
        ok: false,
        reason: "TRAILING_UNLOCK_PCT_OUT_OF_BOUNDS",
      });
    }
  });

  test("accepts only the trailing set", () => {
    for (const pct of TRAILING_PCT_OPTIONS) expect(validateTrailingPct(pct).ok).toBe(true);
    for (const pct of [0, 2, 9, 12, 25, 10.5, Number.NaN]) {
      expect(validateTrailingPct(pct)).toEqual({ ok: false, reason: "TRAILING_PCT_NOT_ALLOWED" });
    }
  });
});

describe("docs/domain-rules.md §7 stop", () => {
  test("30% stop from the average fill price", () => {
    expect(stopLevel(usd("100"), 30)).toBe(usd("70"));
    expect(stopLevel(usd("2.50"), 30)).toBe(usd("1.75"));
  });

  test("rounds down to a whole micro-dollar", () => {
    expect(stopLevel(1, 30)).toBe(0);
    expect(stopLevel(333_333, 30)).toBe(233_333);
  });

  test("throws on an out-of-bounds pct or invalid price", () => {
    expect(() => stopLevel(usd("100"), 9)).toThrow(RangeError);
    expect(() => stopLevel(usd("100"), 51)).toThrow(RangeError);
    expect(() => stopLevel(-1, 30)).toThrow(RangeError);
    expect(() => stopLevel(1.5, 30)).toThrow(RangeError);
  });
});

describe("docs/domain-rules.md §8 trailing eligibility", () => {
  const base = { originalQty: 10, soldQty: 0, trailingUnlockPct: 70 };

  test("requires the confirmed sold share to reach the unlock pct", () => {
    expect(trailingEligible({ ...base, soldQty: 6 })).toBe(false);
    expect(trailingEligible({ ...base, soldQty: 7 })).toBe(true);
    expect(trailingEligible({ ...base, soldQty: 9 })).toBe(true);
  });

  test("needs a remaining quantity", () => {
    expect(trailingEligible({ ...base, soldQty: 10 })).toBe(false);
  });

  test("ignores pending and done_zero steps: only soldQty counts", () => {
    // Extra properties such as committedQty never change the result.
    const withPending = { ...base, soldQty: 6, committedQty: 3 };
    expect(trailingEligible(withPending)).toBe(false);
  });

  test("uses the unlock pct stored on the position", () => {
    expect(trailingEligible({ ...base, soldQty: 3, trailingUnlockPct: 30 })).toBe(true);
    expect(trailingEligible({ ...base, soldQty: 8, trailingUnlockPct: 90 })).toBe(false);
  });

  test("compares exactly with no float rounding", () => {
    expect(trailingEligible({ originalQty: 37, soldQty: 26, trailingUnlockPct: 70 })).toBe(true);
    expect(trailingEligible({ originalQty: 37, soldQty: 25, trailingUnlockPct: 70 })).toBe(false);
  });

  test("throws on an out-of-bounds unlock pct", () => {
    expect(() => trailingEligible({ ...base, trailingUnlockPct: 29 })).toThrow(RangeError);
    expect(() => trailingEligible({ ...base, trailingUnlockPct: 91 })).toThrow(RangeError);
  });
});

describe("docs/domain-rules.md §8 trailing level", () => {
  test("activation sets the peak to the fresh bid", () => {
    expect(activateTrailing(10, usd("50"))).toEqual({
      trailingPct: 10,
      peak: usd("50"),
      level: usd("45"),
    });
  });

  test("raises peak and level on a higher bid", () => {
    const state = nextTrailing(activateTrailing(10, usd("50")), usd("60"));
    expect(state).toEqual({ trailingPct: 10, peak: usd("60"), level: usd("54") });
  });

  test("the level never decreases when the bid falls", () => {
    let state = activateTrailing(20, usd("100"));
    let previous = state.level;
    for (const bid of ["90", "100", "70", "120", "110", "0"]) {
      state = nextTrailing(state, usd(bid));
      expect(state.level).toBeGreaterThanOrEqual(previous);
      previous = state.level;
    }
    expect(state.peak).toBe(usd("120"));
    expect(state.level).toBe(usd("96"));
  });

  test("does not mutate the input state", () => {
    const state = activateTrailing(10, usd("50"));
    const copy = { ...state };
    nextTrailing(state, usd("80"));
    expect(state).toEqual(copy);
  });

  test("rejects a trailing pct outside the set", () => {
    expect(() => activateTrailing(12, usd("50"))).toThrow(RangeError);
    expect(() => nextTrailing({ trailingPct: 0, peak: 1, level: 0 }, 1)).toThrow(RangeError);
  });

  test("rejects an invalid bid", () => {
    const state = activateTrailing(10, usd("50"));
    expect(() => nextTrailing(state, -1)).toThrow(RangeError);
    expect(() => nextTrailing(state, 0.5)).toThrow(RangeError);
  });
});

describe("shouldExit", () => {
  const position = { avgEntryPrice: usd("100"), stopPct: 30, trailing: null };

  test("without trailing, exits at or below the stop level only", () => {
    expect(shouldExit(position, usd("70.000001"))).toBe(false);
    expect(shouldExit(position, usd("70"))).toBe(true);
    expect(shouldExit(position, usd("40"))).toBe(true);
  });

  test("uses the higher of stop and trail levels", () => {
    const trailing = activateTrailing(10, usd("200")); // level 180
    const withTrail = { ...position, trailing };
    expect(shouldExit(withTrail, usd("180.000001"))).toBe(false);
    expect(shouldExit(withTrail, usd("180"))).toBe(true);
  });

  test("the stop wins while the trail level is lower", () => {
    const trailing = activateTrailing(20, usd("80")); // level 64 < stop 70
    const withTrail = { ...position, trailing };
    expect(shouldExit(withTrail, usd("70"))).toBe(true);
    expect(shouldExit(withTrail, usd("71"))).toBe(false);
  });

  test("throws on an out-of-bounds stop pct or invalid bid", () => {
    expect(() => shouldExit({ ...position, stopPct: 5 }, usd("80"))).toThrow(RangeError);
    expect(() => shouldExit(position, -1)).toThrow(RangeError);
  });
});
