// Closing an option on its expiration day (decision D45, docs/domain-rules.md §7). A long option in
// the money at expiry is exercised into shares the app never opened; out of the money it vanishes.
// Pure: `now` is a parameter and the close comes from the calendar, never a literal.

import { getCalendar } from "market-calendar";
import { EXPIRY_CLOSE_LEAD_MS } from "./config.ts";
import { sessionDate } from "./calendar.ts";

// The option session, the same calendar `isRegularSession` uses for options.
const OPTIONS_CALENDAR = "CBOE_Equity_Options";

function sessionCloseMs(day: string): number | null {
  const [session] = getCalendar(OPTIONS_CALENDAR).schedule(day, day);
  return session === undefined ? null : session.market_close.toMillis();
}

/** When the engine closes an option that expires on `expiration` (YYYY-MM-DD); null if that day has no session. */
export function expiryCloseAt(expiration: string): Date | null {
  const close = sessionCloseMs(expiration);
  return close === null ? null : new Date(close - EXPIRY_CLOSE_LEAD_MS);
}

/** True from the start of the expiration day in New York (the warning shows from then). */
export function isExpirationDay(expiration: string, now: Date): boolean {
  return sessionDate(now) === expiration;
}

/** True from the lead before that day's close until the close itself; later, the exit path is shut anyway. */
export function shouldCloseAtExpiry(expiration: string, now: Date): boolean {
  const close = sessionCloseMs(expiration);
  if (close === null || !isExpirationDay(expiration, now)) return false;
  return now.getTime() >= close - EXPIRY_CLOSE_LEAD_MS && now.getTime() < close;
}
