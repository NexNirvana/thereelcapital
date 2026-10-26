import { describe, expect, test } from "bun:test";
import {
  choiceFor,
  defaultExpiration,
  fallbackNotice,
  parseQuery,
  resolveExpiration,
  shortDate,
  suggest,
  suggestionLabel,
} from "./expiration-field.ts";

// Monday 26 Oct 2026, 12:00 in New York (EDT).
const monday = new Date("2026-10-26T16:00:00Z");
const listed = [
  "2026-10-30",
  "2026-10-26",
  "2026-11-02",
  "2026-11-06",
  "2026-12-18",
  "2027-01-15",
  "2027-06-17",
];

describe("labels", () => {
  test("words today, tomorrow and days away", () => {
    expect(suggestionLabel("2026-10-26", monday)).toBe("lun 26 oct 2026 · Hoy");
    expect(suggestionLabel("2026-10-27", monday)).toBe("mar 27 oct 2026 · mañana");
    expect(suggestionLabel("2026-10-30", monday)).toBe("vie 30 oct 2026 · en 4 días");
  });

  test("counts days from the New York day, not the UTC one", () => {
    // 22:00 in New York on the 26th is already the 27th in UTC.
    const lateMonday = new Date("2026-10-27T02:00:00Z");
    expect(suggestionLabel("2026-10-26", lateMonday)).toContain("Hoy");
    // 00:30 in New York on the 27th.
    const earlyTuesday = new Date("2026-10-27T04:30:00Z");
    expect(suggestionLabel("2026-10-27", earlyTuesday)).toContain("Hoy");
    expect(suggestionLabel("2026-10-26", earlyTuesday)).toBe("lun 26 oct 2026 · hace 1 día");
  });

  test("shortens a nearest date and keeps the year when it is another one", () => {
    expect(shortDate("2026-10-30", monday)).toBe("30 oct");
    expect(shortDate("2027-01-15", monday)).toBe("15 ene 2027");
  });
});

describe("parseQuery", () => {
  test("reads day and month, month, year and ISO dates", () => {
    expect(parseQuery("30 oct")).toEqual({ kind: "parts", year: undefined, month: 9, day: 30 });
    expect(parseQuery("Nov")).toEqual({
      kind: "parts",
      year: undefined,
      month: 10,
      day: undefined,
    });
    expect(parseQuery("2027")).toEqual({
      kind: "parts",
      year: 2027,
      month: undefined,
      day: undefined,
    });
    expect(parseQuery("2026-10-30")).toEqual({ kind: "parts", year: 2026, month: 9, day: 30 });
    expect(parseQuery("sept 2027")).toEqual({
      kind: "parts",
      year: 2027,
      month: 8,
      day: undefined,
    });
    expect(parseQuery("hoy")).toEqual({ kind: "today" });
    expect(parseQuery("  ")).toEqual({ kind: "empty" });
  });

  test("reads the text of a chosen suggestion back", () => {
    expect(parseQuery("vie 30 oct 2026 · en 4 días")).toEqual(parseQuery("2026-10-30"));
    expect(parseQuery("mar 27 oct 2026 · mañana")).toEqual(parseQuery("2026-10-27"));
    // «mar» alone is March.
    expect(parseQuery("mar 2027")).toEqual({ kind: "parts", year: 2027, month: 2, day: undefined });
  });

  test("keeps 29 feb valid without a year", () => {
    expect(parseQuery("29 feb")).toEqual({ kind: "parts", year: undefined, month: 1, day: 29 });
  });

  test("rejects what is not a date", () => {
    for (const text of [
      "abc",
      "40 oct",
      "2026-02-31",
      "31 feb",
      "31 nov",
      "30 oct 1999 x",
      "30 31",
      "<script>",
    ]) {
      expect(parseQuery(text).kind).toBe("bad");
    }
  });
});

describe("suggest", () => {
  test("lists every expiration, earliest first, for empty text", () => {
    expect(suggest(listed, "", monday)[0]).toBe("2026-10-26");
    expect(suggest(listed, "", monday)).toHaveLength(listed.length);
  });

  test("filters by day and month, by month and by year", () => {
    expect(suggest(listed, "30 oct", monday)).toEqual(["2026-10-30"]);
    expect(suggest(listed, "nov", monday)).toEqual(["2026-11-02", "2026-11-06"]);
    expect(suggest(listed, "2027", monday)).toEqual(["2027-01-15", "2027-06-17"]);
    expect(suggest(listed, "hoy", monday)).toEqual(["2026-10-26"]);
    expect(suggest(listed, "zzz", monday)).toEqual([]);
  });
});

describe("resolveExpiration", () => {
  test("finds a single match and says when several match", () => {
    expect(resolveExpiration(listed, "2026-10-30", monday)).toEqual({
      kind: "found",
      date: "2026-10-30",
    });
    expect(resolveExpiration(listed, "30 oct", monday)).toEqual({
      kind: "found",
      date: "2026-10-30",
    });
    expect(resolveExpiration(listed, "nov", monday)).toEqual({
      kind: "several",
      dates: ["2026-11-02", "2026-11-06"],
    });
  });

  test("names the nearest dates for a date that is not listed", () => {
    expect(resolveExpiration(listed, "1 nov", monday)).toEqual({
      kind: "missing",
      lead: "No hay vencimiento el 1 nov 2026",
      nearest: ["2026-10-30", "2026-11-02"],
    });
  });

  test("a date already past this year points at next year", () => {
    const result = resolveExpiration(listed, "10 ene", monday);
    expect(result).toMatchObject({
      kind: "missing",
      lead: "No hay vencimiento el 10 ene 2027",
      nearest: ["2026-12-18", "2027-01-15"],
    });
  });

  test("names a month or a year with no expirations", () => {
    expect(resolveExpiration(listed, "mar 2027", monday)).toMatchObject({
      lead: "No hay vencimiento en mar 2027",
      nearest: ["2027-01-15", "2027-06-17"],
    });
    expect(resolveExpiration(listed, "2030", monday)).toMatchObject({
      lead: "No hay vencimiento en 2030",
      nearest: ["2027-06-17"],
    });
  });

  test("says there is none today and offers the next", () => {
    const withoutToday = listed.filter((date) => date !== "2026-10-26");
    expect(resolveExpiration(withoutToday, "hoy", monday)).toEqual({
      kind: "missing",
      lead: "Hoy no hay vencimiento",
      nearest: ["2026-10-30"],
    });
  });

  test("reports empty and unreadable text", () => {
    expect(resolveExpiration(listed, "", monday).kind).toBe("empty");
    expect(resolveExpiration(listed, "no sé", monday).kind).toBe("bad");
    expect(resolveExpiration([], "30 oct", monday)).toMatchObject({ kind: "missing", nearest: [] });
  });
});

describe("defaultExpiration", () => {
  test("opens on today when the symbol expires today", () => {
    expect(defaultExpiration(listed, monday)).toEqual({ date: "2026-10-26", isToday: true });
  });

  test("falls back to the next expiration when there is none today", () => {
    const withoutToday = listed.filter((date) => date !== "2026-10-26");
    expect(defaultExpiration(withoutToday, monday)).toEqual({ date: "2026-10-30", isToday: false });
    expect(fallbackNotice("F", "2026-10-30")).toBe(
      "Hoy no hay vencimiento para F. Mostramos el más próximo: vie 30 oct 2026",
    );
  });

  test("follows the New York day across midnight, and across a month or year change", () => {
    // 21:00 New York on 31 Dec 2026 is already 1 Jan in UTC: today is still the 31st.
    const newYearsEve = new Date("2027-01-01T02:00:00Z");
    expect(defaultExpiration(["2026-12-31", "2027-01-15"], newYearsEve)).toEqual({
      date: "2026-12-31",
      isToday: true,
    });
    const newYear = new Date("2027-01-01T06:00:00Z");
    expect(defaultExpiration(["2026-12-31", "2027-01-15"], newYear)).toEqual({
      date: "2027-01-15",
      isToday: false,
    });
  });

  test("has no default when every expiration is past or none is listed", () => {
    expect(defaultExpiration([], monday)).toBeNull();
    expect(defaultExpiration(["2026-10-23"], monday)).toBeNull();
  });
});

describe("choiceFor", () => {
  test("words each case and offers the dates", () => {
    expect(choiceFor(resolveExpiration(listed, "1 nov", monday), "1 nov")).toEqual({
      lead: "No hay vencimiento el 1 nov 2026. Más cercanos:",
      dates: ["2026-10-30", "2026-11-02"],
    });
    expect(choiceFor(resolveExpiration(listed, "nov", monday), "nov")?.dates).toHaveLength(2);
    expect(choiceFor(resolveExpiration(listed, "xyz", monday), "xyz")?.dates).toEqual([]);
    expect(choiceFor(resolveExpiration(listed, "30 oct", monday), "30 oct")).toBeNull();
  });
});
