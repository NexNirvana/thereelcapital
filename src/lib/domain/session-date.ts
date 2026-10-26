// Kept apart from the calendar (which loads the market-calendar library) so the browser can ask
// which New York day it is without bundling the library.

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
