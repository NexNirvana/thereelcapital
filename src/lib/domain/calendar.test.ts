import { describe, expect, test } from "bun:test";
import {
  COVERED_YEARS,
  EARLY_CLOSES,
  HOLIDAYS,
  isRegularSession,
  sessionDate,
} from "./calendar";

const equity = { kind: "equity" };
const option = { kind: "option" };
const at = (iso: string): Date => new Date(iso);

describe("sessionDate", () => {
  test("uses the New York day, not UTC", () => {
    // 04:30 UTC is 00:30 EDT of the same day; 03:30 UTC is 23:30 EDT of the day before.
    expect(sessionDate(at("2026-06-10T04:30:00Z"))).toBe("2026-06-10");
    expect(sessionDate(at("2026-06-10T03:30:00Z"))).toBe("2026-06-09");
  });
  test("just after midnight ET in winter (EST)", () => {
    expect(sessionDate(at("2026-12-01T05:01:00Z"))).toBe("2026-12-01");
    expect(sessionDate(at("2026-12-01T04:59:00Z"))).toBe("2026-11-30");
  });
});

describe("isRegularSession", () => {
  test("open on a normal weekday between 09:30 and 16:00 ET", () => {
    expect(isRegularSession(equity, at("2026-06-10T13:30:00Z"))).toEqual({ open: true }); // 09:30 EDT
    expect(isRegularSession(option, at("2026-06-10T19:59:00Z"))).toEqual({ open: true }); // 15:59 EDT
  });
  test("closed before 09:30 and from 16:00 ET", () => {
    expect(isRegularSession(equity, at("2026-06-10T13:29:00Z")).open).toBe(false);
    expect(isRegularSession(equity, at("2026-06-10T20:00:00Z")).open).toBe(false);
    expect(isRegularSession(equity, at("2026-12-01T14:29:00Z")).open).toBe(false); // 09:29 EST
    expect(isRegularSession(equity, at("2026-12-01T21:00:00Z")).open).toBe(false); // 16:00 EST
  });
  test("closed on weekends", () => {
    expect(isRegularSession(equity, at("2026-06-13T15:00:00Z"))).toMatchObject({ open: false }); // Sat
    expect(isRegularSession(equity, at("2026-06-14T15:00:00Z"))).toMatchObject({ open: false }); // Sun
  });
  test("closed on every 2026-2027 holiday", () => {
    expect(HOLIDAYS.size).toBe(20);
    for (const day of HOLIDAYS) {
      const result = isRegularSession(equity, at(`${day}T17:00:00Z`)); // midday ET
      expect(result.open).toBe(false);
    }
  });
  test("holidays fall on weekdays", () => {
    for (const day of HOLIDAYS) {
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      expect(dow >= 1 && dow <= 5).toBe(true);
    }
  });
  test("early closes end at 13:00 ET", () => {
    expect(EARLY_CLOSES.size).toBe(3);
    for (const day of EARLY_CLOSES) {
      // Every early close is in November or December, so ET is EST (UTC-5).
      const inEt = (hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);
      expect(isRegularSession(equity, inEt("12:59"))).toEqual({ open: true });
      expect(isRegularSession(equity, inEt("13:00")).open).toBe(false);
      expect(isRegularSession(equity, inEt("15:00")).open).toBe(false);
    }
  });
  test("DST starts 2026-03-08 and ends 2026-11-01", () => {
    // Friday before the change: still EST, 09:30 EST = 14:30Z.
    expect(isRegularSession(equity, at("2026-03-06T14:30:00Z"))).toEqual({ open: true });
    // Monday after spring forward: 09:30 EDT = 13:30Z; 14:29Z is already open, 13:29Z is not.
    expect(isRegularSession(equity, at("2026-03-09T13:29:00Z")).open).toBe(false);
    expect(isRegularSession(equity, at("2026-03-09T13:30:00Z"))).toEqual({ open: true });
    // Friday before fall back: EDT. Monday after: EST.
    expect(isRegularSession(equity, at("2026-10-30T13:30:00Z"))).toEqual({ open: true });
    expect(isRegularSession(equity, at("2026-11-02T14:29:00Z")).open).toBe(false);
    expect(isRegularSession(equity, at("2026-11-02T14:30:00Z"))).toEqual({ open: true });
    expect(isRegularSession(equity, at("2026-11-02T20:59:00Z"))).toEqual({ open: true });
    expect(isRegularSession(equity, at("2026-11-02T21:00:00Z")).open).toBe(false);
  });
  test("the DST-change Sunday itself is closed and keeps its New York date", () => {
    expect(isRegularSession(equity, at("2026-03-08T15:00:00Z")).open).toBe(false);
    expect(sessionDate(at("2026-03-08T06:59:00Z"))).toBe("2026-03-08"); // 01:59 EST
    expect(sessionDate(at("2026-03-08T07:00:00Z"))).toBe("2026-03-08"); // 03:00 EDT
    expect(sessionDate(at("2026-11-01T05:30:00Z"))).toBe("2026-11-01"); // 01:30 EDT
    expect(sessionDate(at("2026-11-01T06:30:00Z"))).toBe("2026-11-01"); // 01:30 EST
  });
  test("rejects instruments without a calendar entry, with a reason", () => {
    const result = isRegularSession({ kind: "future" }, at("2026-06-10T15:00:00Z"));
    expect(result.open).toBe(false);
    if (!result.open) expect(result.reason).toContain("future");
  });
});

describe("table coverage", () => {
  test("covers the current year (fails when the table must be extended)", () => {
    const year = Number(sessionDate(new Date()).slice(0, 4));
    expect(COVERED_YEARS).toContain(year);
  });
});
