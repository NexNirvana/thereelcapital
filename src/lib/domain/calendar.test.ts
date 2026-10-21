import { describe, expect, test } from "bun:test";
import { getCalendar } from "market-calendar";
import { isRegularSession, sessionDate } from "./calendar";

// NYSE's published calendar (https://www.nyse.com/markets/hours-calendars).
// These fixtures check the library; they are not used by the app.
const NYSE_HOLIDAYS = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
];
const NYSE_EARLY_CLOSES = ["2026-11-27", "2026-12-24", "2027-11-26"];

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
  test("closed on every NYSE holiday in 2026 and 2027, for equities and options", () => {
    for (const day of NYSE_HOLIDAYS) {
      const noon = new Date(`${day}T12:00:00-05:00`);
      expect(isRegularSession(equity, noon)).toEqual({ open: false, reason: "Market closed: no session today" });
      expect(isRegularSession(option, noon).open).toBe(false);
    }
  });
  test("early closes end at 13:00 ET", () => {
    for (const day of NYSE_EARLY_CLOSES) {
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

describe("market-calendar", () => {
  test("matches the NYSE published holidays and early closes for 2026 and 2027", () => {
    const nyse = getCalendar("NYSE");
    const schedule = nyse.schedule("2026-01-01", "2027-12-31");
    const tradingDays = new Set(schedule.map((s) => s.date.toISODate()));
    const weekdays: string[] = [];
    for (let d = new Date(Date.UTC(2026, 0, 1)); d.getUTCFullYear() < 2028; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) weekdays.push(d.toISOString().slice(0, 10));
    }
    expect(weekdays.filter((day) => !tradingDays.has(day))).toEqual(NYSE_HOLIDAYS);
    expect(nyse.earlyCloses(schedule).map((s) => s.date.toISODate())).toEqual(NYSE_EARLY_CLOSES);
  });
});
