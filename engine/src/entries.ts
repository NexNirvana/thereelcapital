// Entry orders: prepare (read-only preview) and send (reserve, persist, place once).
// docs/order-lifecycle.md, docs/domain-rules.md §1, §3, §4, §5. The browser names an instrument and
// an account; SIZE comes from the client's settings (D1) and the price from the broker, so nothing
// the browser sends can change what is ordered (CLAUDE.md, rule 3).
//
// Shape of sendEntry, in the order that keeps the money rules:
//   1. awaits: connection, SIZE, symbol details and a fresh quote (nothing is written)
//   2. ONE synchronous transaction: guards, limits, reservation, intent persisted (ARMED)
//   3. mark SENT, then the single broker call (never retried)
//   4. a synchronous write of the outcome: ACKNOWLEDGED, REJECTED (releases) or UNKNOWN (holds)

import { sessionDate } from "#lib/domain/calendar.ts";
import { entryBlock } from "#lib/domain/connection.ts";
import {
  canReserveEntry,
  canReserveSlot,
  checkOrder,
  MAX_OPEN_POSITIONS,
  type RejectionReason,
} from "#lib/domain/guards.ts";
import {
  appliedSize,
  computeEntryQty,
  type EntryAsk,
  type EntryBlockReason,
  type SizeChoice,
} from "#lib/domain/sizing.ts";
import type { BrokerAdapterShape, OrderRequest, Quote, SymbolDetails } from "./broker/adapter.ts";
import { cachedSymbolDetails } from "./symbol-details.ts";
import { attempt } from "./broker/attempt.ts";
import { connectionViewOf, type ConnectionContext } from "./connection.ts";
import { loadEntryInputs, type EntryInputsCache } from "./entry-inputs.ts";
import { logEvent } from "./events.ts";
import { placeOnce } from "./placement.ts";
import { newIntentId } from "./ids.ts";
import { reconciliationPending } from "./refresh.ts";
import {
  failure,
  success,
  type EngineResult,
  type PrepareEntryArgs,
  type SendEntryArgs,
} from "./rpc.ts";

export interface EntryContext extends ConnectionContext {
  readonly broker: BrokerAdapterShape;
}

/** Why an entry cannot go ahead. Stable codes; the web Worker maps them to Spanish copy. */
export type EntryBlockCode =
  | EntryBlockReason
  | RejectionReason
  | "NOT_CONNECTED"
  | "CONNECTION_UNUSABLE"
  | "RECONCILIATION_PENDING"
  | "SIZE_UNAVAILABLE"
  | "DAILY_ENTRY_LIMIT"
  | "OPEN_POSITION_LIMIT";

export interface EntryPreview {
  readonly status: "READY";
  /** Becomes the OrderConfirmID. Send it back unchanged to repeat the same order. */
  readonly intentId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly assetType: "equity" | "option";
  readonly qty: number;
  /** The SIZE this entry is sized with: the client's SIZE or the share they chose (D51). */
  readonly sizeMicros: number;
  /** Echo of the choice applied, so the web Worker can refuse an engine that ignored it. */
  readonly sizeChoice: SizeChoice;
  readonly askMicros: number;
  readonly pointValue: number;
  /** ask × qty × point value (options); the SIZE is a target, a MARKET fill can cost more. */
  readonly estimatedCostMicros: number;
}

export type PrepareEntryResult =
  EntryPreview | { readonly status: "BLOCKED"; readonly reasons: readonly EntryBlockCode[] };

export type SendEntryResult =
  | { readonly status: "BLOCKED"; readonly reasons: readonly EntryBlockCode[] }
  /** The quantity the server computes now differs from the one confirmed: nothing was reserved. */
  | { readonly status: "RECONFIRM"; readonly preview: EntryPreview }
  | {
      readonly status: "PLACED";
      readonly intentId: string;
      readonly state: string;
      readonly qty: number;
      /** True when this intent already existed: the broker was not called again. */
      readonly replay: boolean;
    };

/**
 * An entry holds a slot from the moment it is reserved until it has a position (reconciliation
 * creates the position when the entry is terminal) or is rejected or canceled with no fill.
 * PARTIAL is included: it has filled but has no position yet (architecture.md#data-model).
 */
const SLOT_HOLDING_STATES =
  "('ARMED', 'SENT', 'ACKNOWLEDGED', 'PARTIAL', 'CANCEL_PENDING', 'UNKNOWN')";
/** Symbols that already have, or are about to have, a position. */
const PENDING_ENTRY_STATES =
  "('ARMED', 'SENT', 'ACKNOWLEDGED', 'PARTIAL', 'CANCEL_PENDING', 'UNKNOWN')";

const MICROS_PER_USD = 1_000_000;

interface Sized {
  readonly accountId: string;
  readonly accountType: string;
  readonly symbol: string;
  readonly assetType: "equity" | "option";
  /** Long-only: a buy to open, derived once and used by the guard, the intent row and the order. */
  readonly tradeAction: "BUY" | "BUYTOOPEN";
  readonly qty: number;
  readonly sizeMicros: number;
  readonly sizeChoice: SizeChoice;
  readonly quote: Quote;
  readonly askMicros: number;
  readonly pointValue: number;
}

type Evaluation =
  | { readonly kind: "blocked"; readonly reasons: readonly EntryBlockCode[] }
  | { readonly kind: "ready"; readonly sized: Sized; readonly maxDailyEntries: number };

function askOf(quote: Quote | undefined): EntryAsk | null {
  if (quote === undefined) return null;
  if (quote.isHalted) return { status: "halted" };
  if (quote.ask === null) return null;
  // A delayed quote is not the price we would trade at; the broker has no bid/ask timestamp.
  if (quote.isDelayed) return { status: "stale" };
  return { status: "fresh", price: quote.ask };
}

function openSymbols(sql: SqlStorage): string[] {
  return sql
    .exec<{ symbol: string }>(
      `SELECT symbol FROM positions WHERE mode = 'SIM' AND status != 'CLOSED'
       UNION SELECT symbol FROM intents
         WHERE mode = 'SIM' AND kind = 'entry' AND state IN ${PENDING_ENTRY_STATES}`,
    )
    .toArray()
    .map((row) => row.symbol);
}

function guardEntry(ctx: ConnectionContext, sized: Sized): RejectionReason | null {
  const result = checkOrder(
    {
      mode: "SIM",
      accountId: sized.accountId,
      instrument:
        sized.assetType === "equity"
          ? { kind: "equity", symbol: sized.symbol }
          : { kind: "option", symbol: sized.symbol, legs: 1 },
      orderType: "Market",
      tradeAction: sized.tradeAction,
      quantity: sized.qty,
    },
    {
      clientId: ctx.userId,
      account: { id: sized.accountId, clientId: ctx.userId, type: sized.accountType, active: true },
      available: 0,
      openSymbols: openSymbols(ctx.sql),
      now: new Date(ctx.now),
    },
  );
  return result.ok ? null : result.reason;
}

interface LimitCounts {
  readonly consumed: number;
  readonly reserved: number;
  readonly open: number;
  readonly reservedOpens: number;
}

/** What the limits count today, read synchronously (callers rely on that inside the reservation transaction). */
export function limitCounts(ctx: Pick<ConnectionContext, "sql" | "now">): LimitCounts {
  const date = sessionDate(new Date(ctx.now));
  const counters = ctx.sql
    .exec<{ consumed: number; reserved: number }>(
      "SELECT consumed, reserved FROM entry_counters WHERE mode = 'SIM' AND session_date = ?",
      date,
    )
    .toArray()[0] ?? { consumed: 0, reserved: 0 };
  const open = ctx.sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM positions WHERE mode = 'SIM' AND status != 'CLOSED'",
    )
    .one().n;
  // A settled external entry that never became a position is another client's purchase held back
  // by a shared hold (reconcile.ts, D49): it takes no slot.
  const reservedOpens = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM intents
         WHERE mode = 'SIM' AND kind = 'entry' AND position_id IS NULL
           AND (state IN ${SLOT_HOLDING_STATES} OR filled_qty > 0)
           AND NOT (source = 'external' AND state IN ('FILLED', 'CANCELED', 'REJECTED'))`,
    )
    .one().n;
  return { ...counters, open, reservedOpens };
}

/** Daily and slot limits (entries only). Read inside the reservation transaction. */
function limitReasons(ctx: ConnectionContext, maxDailyEntries: number): EntryBlockCode[] {
  const counts = limitCounts(ctx);
  const reasons: EntryBlockCode[] = [];
  if (!canReserveEntry(counts, maxDailyEntries)) reasons.push("DAILY_ENTRY_LIMIT");
  if (!canReserveSlot(counts)) reasons.push("OPEN_POSITION_LIMIT");
  return reasons;
}

export interface EntryLimits {
  /** Open positions plus entries still holding a slot, out of `maxPositions`. */
  readonly positions: number;
  readonly maxPositions: number;
  /** Entries consumed or reserved on this market day, out of `maxEntries`. */
  readonly entriesToday: number;
  readonly maxEntries: number;
}

/** The numbers behind «x/2 posiciones · y/N entradas hoy», N being the client's own limit: the same counts that block an entry. */
export function entryLimits(
  ctx: Pick<ConnectionContext, "sql" | "now">,
  maxDailyEntries: number,
): EntryLimits {
  const counts = limitCounts(ctx);
  return {
    positions: counts.open + counts.reservedOpens,
    maxPositions: MAX_OPEN_POSITIONS,
    entriesToday: counts.consumed + counts.reserved,
    maxEntries: maxDailyEntries,
  };
}

/** Everything that needs an await and writes nothing: connection, SIZE, details, quote, sizing. */
async function evaluate(
  ctx: EntryContext,
  args: PrepareEntryArgs,
  streamed?: Quote,
  inputsCache?: EntryInputsCache,
): Promise<EngineResult<Evaluation>> {
  const blocked = (...reasons: EntryBlockCode[]) =>
    success<Evaluation>({ kind: "blocked", reasons });

  // The live preview reads these from the Durable Object's copy; everything else reads D1.
  const inputs = await (inputsCache === undefined ? loadEntryInputs(ctx) : inputsCache.read(ctx));
  const view = connectionViewOf(ctx, inputs.connection);
  if (view.status === "NOT_CONNECTED") return blocked("NOT_CONNECTED");
  const block = entryBlock({
    health: view.health,
    reconciliationPending: reconciliationPending(ctx.storage),
  });
  if (block !== null) return blocked(block);
  const account = view.accounts.find((candidate) => candidate.accountId === args.accountId);
  if (account === undefined) return blocked("ACCOUNT_NOT_OWNED");

  // The broker reads go together; the checks below keep the old precedence: SIZE, then the symbol
  // details, then the quote. The details are cached; the quote is for the requested symbol, which
  // is the one the details carry.
  const [details, quotes] = await Promise.all([
    cachedSymbolDetails(ctx, args.symbol),
    // A quote the stream just delivered replaces the snapshot read (D47); sendEntry never takes one.
    streamed === undefined
      ? attempt(ctx.broker.quotes([args.symbol]))
      : Promise.resolve({ ok: true as const, value: [streamed] }),
  ]);
  if (inputs.sizeUsd === null || !Number.isSafeInteger(inputs.sizeUsd * MICROS_PER_USD)) {
    return blocked("SIZE_UNAVAILABLE");
  }
  // The browser names only the choice; the SIZE is the client's, read from D1 (D51).
  const sizeChoice = args.sizeChoice ?? "full";
  const sizeMicros = appliedSize(inputs.sizeUsd * MICROS_PER_USD, sizeChoice);

  if (!details.ok) {
    if (details.error._tag === "Rejected") {
      logEvent(ctx, "info", "entry.symbol_rejected", { code: details.error.code });
      return blocked("SYMBOL_DETAILS_MISSING");
    }
    logEvent(ctx, "warn", "entry.details_failed", { failure: details.error._tag });
    return failure("BROKER_UNAVAILABLE");
  }
  const instrument: SymbolDetails = details.value;
  if (instrument.assetType !== args.assetType) return blocked("INSTRUMENT_OUT_OF_SCOPE");

  if (!quotes.ok) {
    logEvent(ctx, "warn", "entry.quote_failed", { failure: quotes.error._tag });
    return failure("BROKER_UNAVAILABLE");
  }
  const quote = quotes.value.find((candidate) => candidate.symbol === instrument.symbol);

  const qty = computeEntryQty({
    size: sizeMicros,
    ask: askOf(quote),
    pointValue: instrument.pointValue,
    increment: instrument.quantityIncrement,
    minQty: instrument.minimumTradeQuantity,
    assetType: args.assetType,
  });
  if (!qty.ok) return blocked(qty.reason);
  if (quote === undefined || quote.ask === null) return blocked("QUOTE_MISSING");

  const sized: Sized = {
    accountId: account.accountId,
    accountType: account.accountType,
    symbol: instrument.symbol,
    assetType: args.assetType,
    tradeAction: args.assetType === "equity" ? "BUY" : "BUYTOOPEN",
    qty: qty.qty,
    sizeMicros,
    sizeChoice,
    quote,
    askMicros: quote.ask,
    pointValue: instrument.pointValue,
  };
  const rejection = guardEntry(ctx, sized);
  return rejection === null
    ? success({ kind: "ready", sized, maxDailyEntries: inputs.maxDailyEntries })
    : blocked(rejection);
}

function previewOf(sized: Sized, intentId: string): EntryPreview {
  const multiplier = sized.assetType === "option" ? sized.pointValue : 1;
  return {
    status: "READY",
    intentId,
    accountId: sized.accountId,
    symbol: sized.symbol,
    assetType: sized.assetType,
    qty: sized.qty,
    sizeMicros: sized.sizeMicros,
    sizeChoice: sized.sizeChoice,
    askMicros: sized.askMicros,
    pointValue: sized.pointValue,
    estimatedCostMicros: Number(BigInt(sized.askMicros) * BigInt(sized.qty) * BigInt(multiplier)),
  };
}

/** Read-only: no intent, no reservation. Limits are reported but only sendEntry reserves. */
export async function prepareEntry(
  ctx: EntryContext,
  args: PrepareEntryArgs,
  streamed?: Quote,
  inputsCache?: EntryInputsCache,
): Promise<EngineResult<PrepareEntryResult>> {
  const evaluated = await evaluate(ctx, args, streamed, inputsCache);
  if (!evaluated.ok) return evaluated;
  if (evaluated.value.kind === "blocked") {
    return success({ status: "BLOCKED", reasons: evaluated.value.reasons });
  }
  const limits = limitReasons(ctx, evaluated.value.maxDailyEntries);
  if (limits.length > 0) return success({ status: "BLOCKED", reasons: limits });
  return success(previewOf(evaluated.value.sized, newIntentId()));
}

interface ExistingIntent extends Record<string, SqlStorageValue> {
  account_id: string;
  symbol: string;
  qty: number;
  state: string;
}

function existingIntent(ctx: ConnectionContext, intentId: string): ExistingIntent | undefined {
  return ctx.sql
    .exec<ExistingIntent>(
      "SELECT account_id, symbol, qty, state FROM intents WHERE id = ? AND mode = 'SIM' AND kind = 'entry'",
      intentId,
    )
    .toArray()[0];
}

/** The same id for the same order is a repeat (no second broker call); for another order it is an error. */
function replayOf(
  ctx: ConnectionContext,
  args: SendEntryArgs,
): EngineResult<SendEntryResult> | null {
  const found = existingIntent(ctx, args.intentId);
  if (found === undefined) return null;
  if (
    found.account_id !== args.accountId ||
    found.symbol.toUpperCase() !== args.symbol.toUpperCase()
  ) {
    return failure("INVALID_INPUT");
  }
  return success({
    status: "PLACED",
    intentId: args.intentId,
    state: found.state,
    qty: found.qty,
    replay: true,
  });
}

type Reservation =
  | { readonly kind: "reserved" }
  | { readonly kind: "blocked"; readonly reasons: readonly EntryBlockCode[] }
  | { readonly kind: "replay" };

/**
 * One synchronous transaction, no await anywhere inside: the guards, both limits and the writes
 * see the same state (order-lifecycle.md, rule 3). Also re-checks what could have changed during
 * the awaits of `evaluate`.
 */
function reserve(
  ctx: ConnectionContext,
  intentId: string,
  sized: Sized,
  maxDailyEntries: number,
): Reservation {
  return ctx.storage.transactionSync((): Reservation => {
    if (existingIntent(ctx, intentId) !== undefined) return { kind: "replay" };
    if (reconciliationPending(ctx.storage)) {
      return { kind: "blocked", reasons: ["RECONCILIATION_PENDING"] };
    }
    const rejection = guardEntry(ctx, sized);
    if (rejection !== null) return { kind: "blocked", reasons: [rejection] };
    const limits = limitReasons(ctx, maxDailyEntries);
    if (limits.length > 0) return { kind: "blocked", reasons: limits };

    ctx.sql.exec(
      `INSERT INTO entry_counters (mode, session_date, consumed, reserved) VALUES ('SIM', ?, 0, 1)
       ON CONFLICT (mode, session_date) DO UPDATE SET reserved = reserved + 1`,
      sessionDate(new Date(ctx.now)),
    );
    const { quote } = sized;
    ctx.sql.exec(
      `INSERT INTO intents
         (id, mode, kind, account_id, position_id, symbol, asset_type, trade_action, qty, size_applied,
          size_choice, quote_json, point_value, state, order_confirm_id, created_at, updated_at)
       VALUES (?, 'SIM', 'entry', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'ARMED', ?, ?, ?)`,
      intentId,
      sized.accountId,
      sized.symbol,
      sized.assetType,
      sized.tradeAction,
      sized.qty,
      sized.sizeMicros,
      sized.sizeChoice,
      JSON.stringify({
        bid: quote.bid,
        ask: quote.ask,
        last: quote.last,
        tradeTime: quote.tradeTime,
        receivedAt: quote.receivedAt,
      }),
      sized.pointValue,
      intentId,
      ctx.now,
      ctx.now,
    );
    return { kind: "reserved" };
  });
}

/** Frees the daily reservation of an entry that never reached the market. The slot frees by itself: it is derived from the state. */
function releaseReservation(ctx: ConnectionContext): void {
  ctx.sql.exec(
    "UPDATE entry_counters SET reserved = reserved - 1 WHERE mode = 'SIM' AND session_date = ? AND reserved > 0",
    sessionDate(new Date(ctx.now)),
  );
}

export async function sendEntry(
  ctx: EntryContext,
  args: SendEntryArgs,
): Promise<EngineResult<SendEntryResult>> {
  const repeated = replayOf(ctx, args);
  if (repeated !== null) return repeated;

  const evaluated = await evaluate(ctx, args);
  // A concurrent send of this same intent may have been persisted while we waited: it is a repeat,
  // not a blocked entry (its own pending intent would trip the one-position-per-symbol guard).
  const concurrent = replayOf(ctx, args);
  if (concurrent !== null) return concurrent;
  if (!evaluated.ok) return evaluated;
  if (evaluated.value.kind === "blocked") {
    return success({ status: "BLOCKED", reasons: evaluated.value.reasons });
  }
  const { sized, maxDailyEntries } = evaluated.value;
  // The quantity is the server's. A different confirmed one means the price or SIZE moved.
  if (sized.qty !== args.confirmedQty) {
    return success({ status: "RECONFIRM", preview: previewOf(sized, args.intentId) });
  }

  const reservation = reserve(ctx, args.intentId, sized, maxDailyEntries);
  if (reservation.kind === "replay") return replayOf(ctx, args) ?? failure("INVALID_INPUT");
  if (reservation.kind === "blocked") {
    return success({ status: "BLOCKED", reasons: reservation.reasons });
  }

  // Persisted above; placeOnce writes SENT before the request can leave.
  const request: OrderRequest = {
    accountId: sized.accountId,
    symbol: sized.symbol,
    assetType: sized.assetType,
    tradeAction: sized.tradeAction,
    quantity: sized.qty,
    orderConfirmId: args.intentId,
  };
  const state = await placeOnce(ctx, ctx.broker, {
    intentId: args.intentId,
    request,
    eventPrefix: "entry",
    giveBack: () => releaseReservation(ctx),
  });
  return success({
    status: "PLACED",
    intentId: args.intentId,
    state,
    qty: sized.qty,
    replay: false,
  });
}
