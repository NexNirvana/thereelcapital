// How the option chain's expiration picker groups and words the dates TradeStation lists: by
// month, each with its weekday, day and days to expiry. Pure: `now` is a parameter and "today" is
// the America/New_York market day (the calendar module), never the runtime's local date.

import { sessionDate } from "#lib/domain/calendar.ts";

export type ExpirationChip = {
  /** The ISO date, the value of `?vencimiento=`. */
  readonly date: string;
  /** "Vie 30 · 4 d" or "Mié 4 · Hoy". */
  readonly label: string;
  /** "viernes 30 de octubre de 2026, vence en 4 días". */
  readonly ariaLabel: string;
  readonly isToday: boolean;
};

export type ExpirationMonth = {
  /** "2026-10": stable key. */
  readonly key: string;
  /** "oct 2026". */
  readonly label: string;
  readonly chips: ReadonlyArray<ExpirationChip>;
};

const DAY_MS = 86_400_000;

// Calendar dates, so the zone is fixed to UTC and the weekday and month never shift.
const WEEKDAY_SHORT = new Intl.DateTimeFormat("es", { weekday: "short", timeZone: "UTC" });
const MONTH_YEAR = new Intl.DateTimeFormat("es", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const LONG_DATE = new Intl.DateTimeFormat("es", { dateStyle: "full", timeZone: "UTC" });

const atUtcMidnight = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Whole market days from the New York day of `now` to `isoDate` (0 = today, negative = past). */
export function daysToExpiry(isoDate: string, now: Date): number {
  return Math.round(
    (atUtcMidnight(isoDate).getTime() - atUtcMidnight(sessionDate(now)).getTime()) / DAY_MS,
  );
}

function relativeShort(days: number): string {
  if (days === 0) return "Hoy";
  return days < 0 ? "Vencido" : `${days} d`;
}

function relativeLong(days: number): string {
  if (days === 0) return "vence hoy";
  if (days === 1) return "vence mañana";
  return days < 0 ? "ya venció" : `vence en ${days} días`;
}

export function expirationChip(isoDate: string, now: Date): ExpirationChip {
  const days = daysToExpiry(isoDate, now);
  const date = atUtcMidnight(isoDate);
  const weekday = capitalize(WEEKDAY_SHORT.format(date).replaceAll(".", ""));
  return {
    date: isoDate,
    label: `${weekday} ${date.getUTCDate()} · ${relativeShort(days)}`,
    ariaLabel: `${LONG_DATE.format(date)}, ${relativeLong(days)}`,
    isToday: days === 0,
  };
}

/** The listed expirations (ISO dates, any order) grouped by month, earliest first. */
export function groupExpirations(
  expirations: ReadonlyArray<string>,
  now: Date,
): ReadonlyArray<ExpirationMonth> {
  const months = new Map<string, { label: string; chips: ExpirationChip[] }>();
  for (const isoDate of [...new Set(expirations)].sort()) {
    const key = isoDate.slice(0, 7);
    const month = months.get(key) ?? {
      label: MONTH_YEAR.format(atUtcMidnight(isoDate)).replaceAll(".", ""),
      chips: [],
    };
    month.chips.push(expirationChip(isoDate, now));
    months.set(key, month);
  }
  return [...months].map(([key, { label, chips }]) => ({ key, label, chips }));
}
