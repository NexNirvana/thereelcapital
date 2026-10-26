import { describe, expect, test } from "bun:test";
import { daysToExpiry, expirationChip, groupExpirations } from "./expirations.ts";

// Monday 2026-10-26, 10:00 in New York (14:00 UTC).
const NOW = new Date("2026-10-26T14:00:00Z");

describe("daysToExpiry", () => {
  test("counts New York calendar days, not 24-hour spans", () => {
    expect(daysToExpiry("2026-10-26", NOW)).toBe(0);
    expect(daysToExpiry("2026-10-30", NOW)).toBe(4);
    // 23:30 in New York is already the next day in UTC.
    expect(daysToExpiry("2026-10-26", new Date("2026-10-27T03:30:00Z"))).toBe(0);
    expect(daysToExpiry("2026-10-27", new Date("2026-10-27T03:30:00Z"))).toBe(1);
  });

  test("is exact across the November daylight saving change", () => {
    expect(daysToExpiry("2026-11-06", NOW)).toBe(11);
  });
});

describe("expirationChip", () => {
  test("marks today's expiry with Hoy", () => {
    const chip = expirationChip("2026-10-26", NOW);
    expect(chip.label).toBe("Lun 26 · Hoy");
    expect(chip.ariaLabel).toBe("lunes, 26 de octubre de 2026, vence hoy");
    expect(chip.isToday).toBe(true);
  });

  test("shows the weekday, the day and the days to expiry", () => {
    const chip = expirationChip("2026-10-30", NOW);
    expect(chip.label).toBe("Vie 30 · 4 d");
    expect(chip.ariaLabel).toBe("viernes, 30 de octubre de 2026, vence en 4 días");
    expect(chip.isToday).toBe(false);
  });

  test("words tomorrow apart in the accessible label", () => {
    expect(expirationChip("2026-10-27", NOW).ariaLabel).toContain("vence mañana");
  });

  test("marks a past date instead of counting backwards", () => {
    expect(expirationChip("2026-10-20", NOW).label).toBe("Mar 20 · Vencido");
  });
});

describe("groupExpirations", () => {
  test("groups by month, earliest first, and keeps the year change", () => {
    const groups = groupExpirations(
      ["2027-01-15", "2026-10-30", "2026-10-26", "2026-12-31", "2027-01-15", "2028-01-21"],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(["oct 2026", "dic 2026", "ene 2027", "ene 2028"]);
    expect(groups[0]?.chips.map((c) => c.date)).toEqual(["2026-10-26", "2026-10-30"]);
    expect(groups[2]?.chips).toHaveLength(1);
  });

  test("returns no groups for no expirations", () => {
    expect(groupExpirations([], NOW)).toEqual([]);
  });
});
