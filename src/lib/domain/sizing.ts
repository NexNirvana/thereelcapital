import { CUSTOM_SIZE_MIN_USD, SIZE_DOWN_APPLIED_PCT } from "./config";
import { assertMicros, MICROS_PER_USD } from "./money";

/**
 * What the client may pick for one entry: the full SIZE, 75% of it (D51) or, when the admin allows
 * it for that client, an amount of their own up to the SIZE (D53). A closed set.
 */
export const SIZE_CHOICES = ["full", "down25", "custom"] as const;
export type SizeChoice = (typeof SIZE_CHOICES)[number];

export const isSizeChoice = (value: unknown): value is SizeChoice =>
  SIZE_CHOICES.some((choice) => choice === value);

// Freshness and halt status are determined by the caller, without a clock here.
export type EntryAsk =
  { status: "fresh"; price: number } | { status: "stale" } | { status: "halted" };

export type EntryBlockReason =
  "QUOTE_MISSING" | "QUOTE_STALE" | "HALTED" | "SYMBOL_DETAILS_MISSING" | "BELOW_MINIMUM";

export type EntryQtyResult = { ok: true; qty: number } | { ok: false; reason: EntryBlockReason };

export interface EntrySizingInput {
  size: number;
  ask: EntryAsk | null;
  pointValue: number | null;
  increment: number | null;
  minQty: number | null;
  assetType: "option" | "equity";
}

function isPositiveInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

/** docs/domain-rules.md §1. SIZE and ask.price are micro-dollars; quantities are integers. */
export function computeEntryQty(input: EntrySizingInput): EntryQtyResult {
  const { size, ask, pointValue, increment, minQty, assetType } = input;
  assertMicros(size);
  if (ask === null) return { ok: false, reason: "QUOTE_MISSING" };
  if (ask.status === "halted") return { ok: false, reason: "HALTED" };
  if (ask.status === "stale") return { ok: false, reason: "QUOTE_STALE" };
  assertMicros(ask.price);
  if (ask.price === 0) return { ok: false, reason: "QUOTE_MISSING" };
  const multiplier = assetType === "option" ? pointValue : 1;
  const step = assetType === "equity" ? increment : 1;
  if (!isPositiveInteger(minQty) || !isPositiveInteger(multiplier) || !isPositiveInteger(step)) {
    return { ok: false, reason: "SYMBOL_DETAILS_MISSING" };
  }

  const costPerStep = BigInt(ask.price) * BigInt(multiplier) * BigInt(step);
  const qty = (BigInt(size) / costPerStep) * BigInt(step);
  if (qty < BigInt(minQty)) return { ok: false, reason: "BELOW_MINIMUM" };
  return { ok: true, qty: Number(qty) };
}

export type SizeChangeResult = { ok: true } | { ok: false; reason: "SIZE_NOT_INCREASED" };

/** docs/domain-rules.md §2. Both values are micro-dollars. */
export function validateSizeChange(current: number, next: number): SizeChangeResult {
  assertMicros(current);
  assertMicros(next);
  return next > current ? { ok: true } : { ok: false, reason: "SIZE_NOT_INCREASED" };
}

/**
 * Deploy skew guard (docs/architecture.md#deploying): the web Worker asked for `requested` and the
 * engine says what it applied. An engine that predates the choice ignores it and answers nothing,
 * which counts as the full SIZE, so a reduced request against it never matches.
 */
export function choiceApplied(
  requested: SizeChoice,
  echoed: SizeChoice | undefined,
  custom?: { readonly requestedUsd: number | undefined; readonly appliedMicros: number },
): boolean {
  if (requested !== (echoed ?? "full")) return false;
  // A custom entry is sized at exactly the amount asked for (D53): any other SIZE is another order.
  return (
    requested !== "custom" ||
    (custom?.requestedUsd !== undefined &&
      custom.appliedMicros === custom.requestedUsd * MICROS_PER_USD)
  );
}

/**
 * docs/domain-rules.md §1. The SIZE one entry is sized with: the client's SIZE, or its
 * SIZE_DOWN_APPLIED_PCT percent. Micro-dollars in and out; a fraction of a micro-dollar rounds down,
 * so the applied SIZE never exceeds the share.
 */
export function appliedSize(size: number, choice: Exclude<SizeChoice, "custom">): number {
  assertMicros(size);
  if (choice === "full") return size;
  return Number((BigInt(size) * BigInt(SIZE_DOWN_APPLIED_PCT)) / 100n);
}

export type EntrySizeResult =
  | { ok: true; sizeMicros: number }
  | { ok: false; reason: "CUSTOM_SIZE_DISABLED" | "CUSTOM_SIZE_OUT_OF_RANGE" };

/**
 * docs/domain-rules.md §1 (D51, D53). The SIZE one entry is sized with, in micro-dollars. A custom
 * amount is whole US dollars, from `CUSTOM_SIZE_MIN_USD` up to the client's SIZE, and only while the
 * admin has the client's switch on; anything else is refused, never clamped. `configuredSize` is
 * micro-dollars; `customUsd` is whatever the browser asked for.
 */
export function entrySize(input: {
  configuredSize: number;
  choice: SizeChoice;
  customUsd: number | undefined;
  customAllowed: boolean;
}): EntrySizeResult {
  const { configuredSize, choice, customUsd, customAllowed } = input;
  if (choice !== "custom") return { ok: true, sizeMicros: appliedSize(configuredSize, choice) };
  if (!customAllowed) return { ok: false, reason: "CUSTOM_SIZE_DISABLED" };
  assertMicros(configuredSize);
  if (
    customUsd === undefined ||
    !Number.isSafeInteger(customUsd) ||
    customUsd < CUSTOM_SIZE_MIN_USD ||
    customUsd * MICROS_PER_USD > configuredSize
  ) {
    return { ok: false, reason: "CUSTOM_SIZE_OUT_OF_RANGE" };
  }
  return { ok: true, sizeMicros: customUsd * MICROS_PER_USD };
}
