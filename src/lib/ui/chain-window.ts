// The pure logic behind the option chain tab: which strikes are on screen, which strike a typed
// text means and how many strikes can be shown. Strikes are micro-dollars, ascending; the prices
// come from TradeStation through the engine and nothing here estimates one.

import { formatStrike } from "./option-chain.ts";

export const STRIKE_COUNTS = [10, 25, 50, "all"] as const;
export type StrikeCount = (typeof STRIKE_COUNTS)[number];
export const DEFAULT_STRIKE_COUNT: StrikeCount = 10;

/** The `strikes` URL parameter: «10», «25», «50» or «todos»; anything else is the default. */
export function parseStrikeCount(text: string | undefined): StrikeCount {
  if (text === "todos") return "all";
  const found = STRIKE_COUNTS.find((count) => String(count) === text);
  return found ?? DEFAULT_STRIKE_COUNT;
}

export function strikeCountParam(count: StrikeCount): string {
  return count === "all" ? "todos" : String(count);
}

/**
 * The strikes on screen: `count` of them with count/2 on each side of `center`, like TradeStation,
 * slid back inside the list near its ends. Without a center the middle of the list is used.
 */
export function strikeWindow(
  strikes: ReadonlyArray<number>,
  count: StrikeCount,
  center: number | null,
): ReadonlyArray<number> {
  if (count === "all" || strikes.length <= count) return strikes;
  const above =
    center === null ? Math.floor(strikes.length / 2) : strikes.findIndex((k) => k >= center);
  const index = above < 0 ? strikes.length : above;
  const start = Math.max(0, Math.min(index - count / 2, strikes.length - count));
  return strikes.slice(start, start + count);
}

/** "400" / "402.50" as a number of micro-dollars; `null` when the text is not a plain amount. */
export function parseStrike(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(\.\d{0,6})?$/.test(normalized) || normalized === "") return null;
  return Math.round(Number.parseFloat(normalized) * 1_000_000);
}

const MAX_SUGGESTIONS = 8;

export type StrikeMatch =
  | { readonly kind: "match"; readonly strikes: ReadonlyArray<number> }
  | { readonly kind: "nearest"; readonly strikes: ReadonlyArray<number> };

/** "402.50" for every strike, so «402.5» and «402.50» both find it. */
const twoDecimals = (micros: number) => (micros / 1_000_000).toFixed(2);

/**
 * The strikes whose text starts with what was typed, closest to the price first (so «2» finds 215
 * before 200). When none starts with it, the nearest strike below and above the typed amount.
 */
export function matchStrikes(
  strikes: ReadonlyArray<number>,
  typed: string,
  price: number | null,
): StrikeMatch {
  const text = typed.trim().replace(",", ".");
  const amount = parseStrike(text);
  if (amount === null) return { kind: "match", strikes: [] };
  const starting = strikes.filter(
    (strike) => formatStrike(strike).startsWith(text) || twoDecimals(strike).startsWith(text),
  );
  if (starting.length > 0) {
    const byDistance = (strike: number) => (price === null ? strike : Math.abs(strike - price));
    const ordered = [...starting].sort((a, b) => byDistance(a) - byDistance(b) || a - b);
    return { kind: "match", strikes: ordered.slice(0, MAX_SUGGESTIONS) };
  }
  const below = strikes.findLast((strike) => strike < amount);
  const above = strikes.find((strike) => strike > amount);
  return {
    kind: "nearest",
    strikes: [below, above].filter((strike): strike is number => strike !== undefined),
  };
}

/** The listed strike a text names exactly («400», «402.5» or «402.50»), or `null`. */
export function exactStrike(strikes: ReadonlyArray<number>, typed: string): number | null {
  const amount = parseStrike(typed);
  return amount === null ? null : (strikes.find((strike) => strike === amount) ?? null);
}

/** The strike closest to the price, the one a placeholder suggests. */
export function strikeNearest(strikes: ReadonlyArray<number>, price: number | null): number | null {
  if (strikes.length === 0) return null;
  if (price === null) return strikes[Math.floor(strikes.length / 2)] ?? null;
  return strikes.reduce((best, strike) =>
    Math.abs(strike - price) < Math.abs(best - price) ? strike : best,
  );
}

export interface CountOption {
  readonly count: StrikeCount;
  readonly label: string;
  /** "395–405", or "21 · 395–405" for all of them. */
  readonly range: string;
}

function rangeOf(shown: ReadonlyArray<number>): string {
  const first = shown[0];
  const last = shown.at(-1);
  return first === undefined || last === undefined
    ? ""
    : `${formatStrike(first)}–${formatStrike(last)}`;
}

/** What each choice of the Mostrar field would show around `center`. */
export function countOptions(
  strikes: ReadonlyArray<number>,
  center: number | null,
): ReadonlyArray<CountOption> {
  return STRIKE_COUNTS.map((count) => {
    const shown = strikeWindow(strikes, count, center);
    return count === "all"
      ? { count, label: "Todos", range: `${strikes.length} · ${rangeOf(shown)}` }
      : { count, label: `${count} strikes`, range: rangeOf(shown) };
  });
}

/** «Mostrando 10 de 87 strikes (395–405), centrados en el precio actual.» */
export function windowSummary(
  total: number,
  shown: ReadonlyArray<number>,
  count: StrikeCount,
  highlighted: number | null,
): string {
  const range = rangeOf(shown);
  const strike = highlighted === null ? null : formatStrike(highlighted);
  if (count === "all" || shown.length === total) {
    return `Mostrando los ${total} strikes (${range})${strike === null ? "" : `, con el ${strike} resaltado`}.`;
  }
  return `Mostrando ${shown.length} de ${total} strikes (${range}), centrados en ${strike === null ? "el precio actual" : `el strike ${strike}`}.`;
}

/** A call is in the money below the price, a put above it. */
export function isInTheMoney(right: "call" | "put", strike: number, price: number | null): boolean {
  if (price === null) return false;
  return right === "call" ? strike < price : strike > price;
}

/** Where the price line goes: before the first shown strike at or above the price. */
export function priceLineBefore(shown: ReadonlyArray<number>, price: number | null): number | null {
  if (price === null) return null;
  const index = shown.findIndex((strike) => strike >= price);
  return index < 0 ? null : index;
}
