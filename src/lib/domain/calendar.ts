// Market calendar: which market day a moment belongs to and whether an
// instrument is inside its regular session. See docs/domain-rules.md#10-market-calendar.
// Sessions, holidays and early closes come from `market-calendar`, a port of
// pandas_market_calendars. Pure functions: `now` is always a parameter.

import { getCalendar } from "market-calendar";

export type InstrumentKind = "equity" | "option";

export type Instrument = { readonly kind: string };

export type SessionCheck =
  { readonly open: true } | { readonly open: false; readonly reason: string };

/** The exchange calendar that defines each instrument kind's regular session. */
const EXCHANGE_CALENDAR: Readonly<Record<InstrumentKind, string>> = {
  equity: "NYSE",
  option: "CBOE_Equity_Options",
};

const newYorkDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The America/New_York calendar day (YYYY-MM-DD) that `now` falls on. */
export function sessionDate(now: Date): string {
  return newYorkDate.format(now);
}

function isKnownKind(kind: string): kind is InstrumentKind {
  return Object.hasOwn(EXCHANGE_CALENDAR, kind);
}

export function isRegularSession(instrument: Instrument, now: Date): SessionCheck {
  if (!isKnownKind(instrument.kind)) {
    return { open: false, reason: `No market calendar for instrument kind "${instrument.kind}"` };
  }
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
