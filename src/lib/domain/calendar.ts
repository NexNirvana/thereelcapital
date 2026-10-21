// Market calendar: which market day a moment belongs to and whether an
// instrument is inside its regular session. See docs/domain-rules.md#10-market-calendar.
// Pure functions: `now` is always a parameter, nothing reads the clock.

const TIME_ZONE = "America/New_York";

/** Instrument kinds the guard knows about. Kinds without a calendar entry are rejected. */
export type Instrument = { readonly kind: string };

export type SessionCheck =
  | { readonly open: true }
  | { readonly open: false; readonly reason: string };

type Session = { readonly open: number; readonly close: number; readonly earlyClose: number };

const MINUTES = (h: number, m: number): number => h * 60 + m;

// Equities and equity options share the NYSE regular session.
// Instruments whose session differs (e.g. some index options) need their own entry.
const NYSE_SESSION: Session = {
  open: MINUTES(9, 30),
  close: MINUTES(16, 0),
  earlyClose: MINUTES(13, 0),
};

const CALENDAR: Readonly<Record<string, Session>> = {
  equity: NYSE_SESSION,
  option: NYSE_SESSION,
};

// Source: https://www.nyse.com/markets/hours-calendars (NYSE holidays and trading hours).
// Dates are ET calendar days, YYYY-MM-DD. Extend before the current year is
// no longer covered; the coverage test fails when it is not.
export const COVERED_YEARS: readonly number[] = [2026, 2027];

export const HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King, Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // Martin Luther King, Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (observed)
  "2027-07-05", // Independence Day (observed)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving Day
  "2027-12-24", // Christmas Day (observed)
]);

/** Days the market closes at 13:00 ET. */
export const EARLY_CLOSES: ReadonlySet<string> = new Set([
  "2026-11-27", // day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2027-11-26", // day after Thanksgiving
]);

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

type EtParts = {
  readonly date: string;
  readonly minutes: number;
  readonly weekend: boolean;
};

function etParts(now: Date): EtParts {
  const p: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) p[part.type] = part.value;
  return {
    date: `${p["year"]}-${p["month"]}-${p["day"]}`,
    minutes: MINUTES(Number(p["hour"]), Number(p["minute"])),
    weekend: p["weekday"] === "Sat" || p["weekday"] === "Sun",
  };
}

/** The America/New_York calendar day (YYYY-MM-DD) that `now` falls on. */
export function sessionDate(now: Date): string {
  return etParts(now).date;
}

export function isRegularSession(instrument: Instrument, now: Date): SessionCheck {
  const session = CALENDAR[instrument.kind];
  if (session === undefined) {
    return { open: false, reason: `No market calendar for instrument kind "${instrument.kind}"` };
  }
  const { date, minutes, weekend } = etParts(now);
  if (weekend) return { open: false, reason: "Market closed: weekend" };
  if (HOLIDAYS.has(date)) return { open: false, reason: "Market closed: holiday" };
  const close = EARLY_CLOSES.has(date) ? session.earlyClose : session.close;
  if (minutes < session.open) return { open: false, reason: "Market closed: before the open" };
  if (minutes >= close) return { open: false, reason: "Market closed: after the close" };
  return { open: true };
}
