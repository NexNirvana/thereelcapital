import { assertMicros } from "./money";

// Freshness and halt status are determined by the caller, without a clock here.
export type EntryAsk =
  | { status: "fresh"; price: number }
  | { status: "stale" }
  | { status: "halted" };

export type EntryBlockReason =
  | "QUOTE_MISSING"
  | "QUOTE_STALE"
  | "HALTED"
  | "SYMBOL_DETAILS_MISSING"
  | "BELOW_MINIMUM";

export type EntryQtyResult =
  | { ok: true; qty: number }
  | { ok: false; reason: EntryBlockReason };

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
  if (
    !isPositiveInteger(minQty) ||
    !isPositiveInteger(multiplier) ||
    !isPositiveInteger(step)
  ) {
    return { ok: false, reason: "SYMBOL_DETAILS_MISSING" };
  }

  const costPerStep = BigInt(ask.price) * BigInt(multiplier) * BigInt(step);
  const qty = (BigInt(size) / costPerStep) * BigInt(step);
  if (qty < BigInt(minQty)) return { ok: false, reason: "BELOW_MINIMUM" };
  return { ok: true, qty: Number(qty) };
}

export type SizeChangeResult =
  | { ok: true }
  | { ok: false; reason: "SIZE_NOT_INCREASED" };

/** docs/domain-rules.md §2. Both values are micro-dollars. */
export function validateSizeChange(current: number, next: number): SizeChangeResult {
  assertMicros(current);
  assertMicros(next);
  return next > current ? { ok: true } : { ok: false, reason: "SIZE_NOT_INCREASED" };
}
