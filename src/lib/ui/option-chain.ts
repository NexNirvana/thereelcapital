// How the option chain screen words contracts, strikes and the age of its snapshot. Prices use
// `formatPrice` from new-entry.ts; the engine sends micro-dollars and nothing here uses floats.

import { CHAIN_STALE_AFTER_MS } from "#lib/domain/config.ts";
import { formatUsd } from "#lib/domain/money.ts";
import { formatPrice } from "./new-entry.ts";

/** "400" or "402.50": a strike in dollars, from micro-dollars, without a "US$" (the header says it). */
export function formatStrike(micros: number): string {
  const [whole = "0", cents = "00"] = formatUsd(micros).slice(1).split(".");
  return cents === "00" ? whole : `${whole}.${cents}`;
}

/** "3.90": a bid or ask cell, the price without its "US$" (the header says it). */
export function formatQuote(micros: number): string {
  return formatPrice(micros).replace("US$", "");
}

const DATE = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "20 nov 2026" from an ISO date (a calendar date, so the zone is fixed to UTC). */
export function formatExpiration(isoDate: string): string {
  return DATE.format(new Date(`${isoDate}T00:00:00Z`)).replaceAll(".", "");
}

const TIME = new Intl.DateTimeFormat("es", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "America/New_York",
});

/** "10:00:05" in New York, where the market runs. */
export function formatSnapshotTime(epochMs: number): string {
  return TIME.format(new Date(epochMs));
}

/** "Call" / "Put". */
export function rightLabel(right: "call" | "put"): string {
  return right === "call" ? "Call" : "Put";
}

/** "Call 400 · 20 nov 2026": the contract without its underlying. */
export function contractLabel(contract: {
  right: "call" | "put";
  strike: number;
  expiration: string;
}): string {
  return `${rightLabel(contract.right)} ${formatStrike(contract.strike)} · ${formatExpiration(contract.expiration)}`;
}

/** "hace 12 s" / "hace 3 min". */
export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  return seconds < 60 ? `hace ${seconds} s` : `hace ${Math.floor(seconds / 60)} min`;
}

export function isStale(ageMs: number): boolean {
  return ageMs > CHAIN_STALE_AFTER_MS;
}
