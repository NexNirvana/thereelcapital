// Market calendar: which market day a moment belongs to and whether an
// instrument is inside its regular session. See docs/domain-rules.md#10-market-calendar.
// Sessions, holidays and early closes come from `market-calendar`, a port of
// pandas_market_calendars. Pure functions: `now` is always a parameter.

import { getCalendar } from "market-calendar";
import { sessionDate } from "./session-date.ts";

export { sessionDate };

export type InstrumentKind = "equity" | "option";

export type Instrument = { readonly kind: InstrumentKind };

export type SessionCheck =
  { readonly open: true } | { readonly open: false; readonly reason: ClosedReason };

export type ClosedReason =
  | "Market closed: no session today"
  | "Market closed: before the open"
  | "Market closed: after the close";

/** The exchange calendar that defines each instrument kind's regular session. */
const EXCHANGE_CALENDAR: Readonly<Record<InstrumentKind, string>> = {
  equity: "NYSE",
  option: "CBOE_Equity_Options",
};

const HOUR_MS = 3_600_000;

/**
 * Epoch ms of 00:00 in New York on `day` (YYYY-MM-DD). New York is 4 or 5 hours behind UTC, so
 * midnight is one of two instants and `sessionDate` says which one lands on `day`.
 */
export function startOfSessionDay(day: string): number {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  const edt = utcMidnight + 4 * HOUR_MS;
  return sessionDate(new Date(edt)) === day ? edt : utcMidnight + 5 * HOUR_MS;
}

/** The calendar day after `day` (YYYY-MM-DD). */
export function nextCalendarDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 24 * HOUR_MS).toISOString().slice(0, 10);
}

export function isRegularSession(instrument: Instrument, now: Date): SessionCheck {
  const day = sessionDate(now);
  const [session] = getCalendar(EXCHANGE_CALENDAR[instrument.kind]).schedule(day, day);
  if (session === undefined) return { open: false, reason: "Market closed: no session today" };

  const t = now.getTime();
  if (t < session.market_open.toMillis())
    return { open: false, reason: "Market closed: before the open" };
  if (t >= session.market_close.toMillis())
    return { open: false, reason: "Market closed: after the close" };
  return { open: true };
}

/** A real calendar day as YYYY-MM-DD, within years a history filter can mean (1970 to 2100). */
export function isCalendarDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00Z`);
  const year = parsed.getUTCFullYear();
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().startsWith(day) &&
    year >= 1970 &&
    year <= 2100
  );
}
