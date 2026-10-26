// The «Vencimiento» field of the option chain: what the user types («30 oct», «nov», «2027»,
// «2026-10-30»), which of the listed expirations it names, the nearest ones when it names none,
// and the default (today in New York, or the next listed). Pure: `now` is a parameter and "today"
// is the America/New_York market day (the calendar module), never the runtime's local date.
// The browser's combobox and the server's no-JavaScript form use these same functions.

import { sessionDate } from "#lib/domain/session-date.ts";
import { formatExpiration } from "./option-chain.ts";

const DAY_MS = 86_400_000;
const WEEKDAY = new Intl.DateTimeFormat("es", { weekday: "short", timeZone: "UTC" });
const MONTH_LONG = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });
const MONTH_SHORT = new Intl.DateTimeFormat("es", { month: "short", timeZone: "UTC" });

const utcDate = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day));
const isoOf = (date: Date) => date.toISOString().slice(0, 10);
const atUtcMidnight = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);

const plain = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replaceAll(".", "");

const MONTHS = Array.from({ length: 12 }, (_, month) => ({
  long: plain(MONTH_LONG.format(utcDate(2026, month, 1))),
  short: plain(MONTH_SHORT.format(utcDate(2026, month, 1))),
}));
const WEEKDAYS = Array.from({ length: 7 }, (_, day) =>
  plain(WEEKDAY.format(utcDate(2026, 0, 4 + day))),
);

/** Whole New York days from today to `isoDate` (0 = today, negative = past). */
export function daysToExpiry(isoDate: string, now: Date): number {
  return Math.round(
    (atUtcMidnight(isoDate).getTime() - atUtcMidnight(sessionDate(now)).getTime()) / DAY_MS,
  );
}

/** "Hoy", "mañana", "en 4 días" (or "hace 2 días" for a date already past). */
export function awayLabel(isoDate: string, now: Date): string {
  const days = daysToExpiry(isoDate, now);
  if (days === 0) return "Hoy";
  if (days === 1) return "mañana";
  return days < 0 ? `hace ${-days} ${-days === 1 ? "día" : "días"}` : `en ${days} días`;
}

/** "vie 30 oct 2026": the weekday and the date, the way the field shows a chosen expiration. */
export function dateLabel(isoDate: string): string {
  const weekday = WEEKDAY.format(atUtcMidnight(isoDate)).replaceAll(".", "");
  return `${weekday} ${formatExpiration(isoDate)}`;
}

/** "vie 30 oct 2026 · en 4 días": one suggestion, and the text of the field once it is chosen. */
export function suggestionLabel(isoDate: string, now: Date): string {
  return `${dateLabel(isoDate)} · ${awayLabel(isoDate, now)}`;
}

export type Query =
  | { readonly kind: "empty" }
  | { readonly kind: "bad" }
  | { readonly kind: "today" }
  | {
      readonly kind: "parts";
      readonly year?: number;
      readonly month?: number;
      readonly day?: number;
    };

const BAD: Query = { kind: "bad" };

function monthOf(token: string): number {
  if (token.length < 3) return -1;
  return MONTHS.findIndex((m) => m.short === token || m.long.startsWith(token));
}

const isRealDate = (year: number, month: number, day: number) => {
  const date = utcDate(year, month, day);
  return date.getUTCMonth() === month && date.getUTCDate() === day;
};

/** Reads what was typed. The text of a chosen suggestion («vie 30 oct 2026 · en 4 días») works too. */
export function parseQuery(text: string): Query {
  const typed = plain(text.split("·")[0] ?? "").trim();
  if (typed === "") return { kind: "empty" };
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typed);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
    return isRealDate(year, month, day) ? { kind: "parts", year, month, day } : BAD;
  }
  let tokens = typed.split(/[\s,./-]+/).filter(Boolean);
  if (tokens.length === 1 && tokens[0] === "hoy") return { kind: "today" };
  // A leading weekday is dropped only when a month follows, since «mar» alone is March.
  const [first = "", ...rest] = tokens;
  if (WEEKDAYS.includes(first) && rest.some((token) => monthOf(token) >= 0)) tokens = rest;
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const value = Number(token);
      if (value >= 2000 && value <= 2200 && year === undefined) year = value;
      else if (value >= 1 && value <= 31 && day === undefined) day = value;
      else return BAD;
    } else {
      const found = monthOf(token);
      if (found < 0 || month !== undefined) return BAD;
      month = found;
    }
  }
  // Without a year, 2024 (a leap year) keeps «29 feb» valid.
  if (day !== undefined && month !== undefined && !isRealDate(year ?? 2024, month, day)) return BAD;
  return { kind: "parts", year, month, day };
}

const sortedUnique = (expirations: ReadonlyArray<string>) => [...new Set(expirations)].sort();

function matchesQuery(isoDate: string, query: Query, now: Date): boolean {
  if (query.kind === "empty") return true;
  if (query.kind === "bad") return false;
  if (query.kind === "today") return isoDate === sessionDate(now);
  const [year, month, day] = isoDate.split("-").map(Number);
  return (
    (query.year === undefined || query.year === year) &&
    (query.month === undefined || query.month === (month ?? 0) - 1) &&
    (query.day === undefined || query.day === day)
  );
}

/** The listed expirations (earliest first) that the typed text names; all of them for empty text. */
export function suggest(
  expirations: ReadonlyArray<string>,
  text: string,
  now: Date,
): ReadonlyArray<string> {
  const query = parseQuery(text);
  return sortedUnique(expirations).filter((isoDate) => matchesQuery(isoDate, query, now));
}

/** The day a date-like query points at, to find the listed dates around it. */
function targetOf(query: Extract<Query, { kind: "parts" }>, now: Date): Date {
  const today = atUtcMidnight(sessionDate(now));
  const year = query.year ?? today.getUTCFullYear();
  const month = query.month ?? (query.year === undefined ? today.getUTCMonth() : 0);
  const day = query.day ?? 1;
  const target = utcDate(year, month, day);
  if (query.year !== undefined || target >= today) return target;
  // Without a year, the next time that date comes around.
  return query.month === undefined ? utcDate(year, month + 1, day) : utcDate(year + 1, month, day);
}

export type Resolution =
  | { readonly kind: "empty" }
  | { readonly kind: "bad" }
  | { readonly kind: "found"; readonly date: string }
  | { readonly kind: "several"; readonly dates: ReadonlyArray<string> }
  | {
      readonly kind: "missing";
      /** "No hay vencimiento el 1 nov 2026". */
      readonly lead: string;
      /** The listed dates just before and after, earliest first. */
      readonly nearest: ReadonlyArray<string>;
    };

/** Decides which listed expiration the text names: the server's check, and the field's on Enter. */
export function resolveExpiration(
  expirations: ReadonlyArray<string>,
  text: string,
  now: Date,
): Resolution {
  const query = parseQuery(text);
  if (query.kind === "empty" || query.kind === "bad") return query;
  const listed = sortedUnique(expirations);
  const matches = listed.filter((isoDate) => matchesQuery(isoDate, query, now));
  const [only, ...others] = matches;
  if (only !== undefined)
    return others.length === 0
      ? { kind: "found", date: only }
      : { kind: "several", dates: matches };

  const today = sessionDate(now);
  if (query.kind === "today") {
    const next = listed.find((isoDate) => isoDate > today);
    return { kind: "missing", lead: "Hoy no hay vencimiento", nearest: next ? [next] : [] };
  }
  const target = isoOf(targetOf(query, now));
  const before = listed.findLast((isoDate) => isoDate < target);
  const after = listed.find((isoDate) => isoDate > target);
  const nearest = [before, after].filter((isoDate): isoDate is string => isoDate !== undefined);
  const [, monthName = "", yearName = ""] = formatExpiration(target).split(" ");
  const named =
    query.month === undefined
      ? query.day === undefined
        ? `en ${yearName}`
        : `con día ${query.day}`
      : query.day === undefined
        ? `en ${monthName} ${yearName}`
        : `el ${formatExpiration(target)}`;
  return { kind: "missing", lead: `No hay vencimiento ${named}`, nearest };
}

/** "30 oct": a nearest date on a link; the year appears only when it is not the current one. */
export function shortDate(isoDate: string, now: Date): string {
  const [day, month, year] = formatExpiration(isoDate).split(" ");
  const sameYear = isoDate.startsWith(sessionDate(now).slice(0, 4));
  return sameYear ? `${day} ${month}` : `${day} ${month} ${year}`;
}

export type DefaultExpiration = {
  readonly date: string;
  /** False when the symbol has no expiration today and this is the next one. */
  readonly isToday: boolean;
};

/** Today's expiration if the symbol lists one, otherwise the next; `null` when none is left. */
export function defaultExpiration(
  expirations: ReadonlyArray<string>,
  now: Date,
): DefaultExpiration | null {
  const today = sessionDate(now);
  const date = sortedUnique(expirations).find((isoDate) => isoDate >= today);
  return date === undefined ? null : { date, isToday: date === today };
}

/** «Hoy no hay vencimiento para F. Mostramos el más próximo: vie 30 oct 2026». */
export function fallbackNotice(underlying: string, isoDate: string): string {
  return `Hoy no hay vencimiento para ${underlying}. Mostramos el más próximo: ${dateLabel(isoDate)}`;
}

export type Choice = { readonly lead: string; readonly dates: ReadonlyArray<string> };

/** What to tell the user, and which dates to offer as links, when the text names no single date. */
export function choiceFor(resolution: Resolution, typed: string): Choice | null {
  switch (resolution.kind) {
    case "bad":
      return {
        lead: "No reconozco esa fecha. Prueba «30 oct», «nov», «2027» o «2026-10-30».",
        dates: [],
      };
    case "several":
      return { lead: `Hay varios vencimientos en «${typed}». Elige uno:`, dates: resolution.dates };
    case "missing":
      return { lead: `${resolution.lead}. Más cercanos:`, dates: resolution.nearest };
    default:
      return null;
  }
}
