// RPC surface of the ClientCoordinator: argument schemas and the typed failure every method can
// return. Arguments never carry a client id (the DO is the client), SIZE, quantity, price or a
// broker URL (CLAUDE.md, never-break rule 3).

import { Schema } from "effect";
import { isCalendarDay } from "#lib/domain/calendar.ts";
import { TRAILING_PCT_OPTIONS } from "#lib/domain/config.ts";
import { ORDER_STATES } from "#lib/domain/order-states.ts";
import { Mode } from "./mode.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const Symbol = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32));

/**
 * What identifies an entry: the instrument and the account. Nothing that sizes or prices it: the
 * engine reads SIZE from the client's settings and the ask from the broker (CLAUDE.md, rule 3).
 */
const EntryTarget = {
  mode: Mode,
  accountId: Id,
  symbol: Symbol,
  assetType: Schema.Literals(["equity", "option"]),
};

export const PrepareEntryArgs = Schema.Struct(EntryTarget);
export type PrepareEntryArgs = typeof PrepareEntryArgs.Type;

/** 16 random bytes in base64url: the length TradeStation allows for an OrderConfirmID (22). */
export const INTENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * `intentId` is the one `prepareEntry` returned; repeating it repeats the same order, never a new
 * one. `confirmedQty` is only what the client saw: it is compared with the server's own quantity
 * and never used to size or send anything.
 */
export const SendEntryArgs = Schema.Struct({
  ...EntryTarget,
  intentId: Schema.String.check(Schema.isPattern(INTENT_ID_PATTERN)),
  confirmedQty: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SendEntryArgs = typeof SendEntryArgs.Type;

/** A scale-out step (index 0 to 6, docs/domain-rules.md §6) or ALL OUT. */
export const ExitArgs = Schema.Struct({
  mode: Mode,
  positionId: Id,
  step: Schema.Union([Schema.Literals([0, 1, 2, 3, 4, 5, 6]), Schema.Literal("ALL_OUT")]),
});
export type ExitArgs = typeof ExitArgs.Type;

export const CancelArgs = Schema.Struct({ mode: Mode, intentId: Id });
export type CancelArgs = typeof CancelArgs.Type;

export const ActivateTrailingArgs = Schema.Struct({
  mode: Mode,
  positionId: Id,
  trailingPct: Schema.Literals(TRAILING_PCT_OPTIONS),
});
export type ActivateTrailingArgs = typeof ActivateTrailingArgs.Type;

/** Tickers as TradeStation writes them: letters, digits, dot, dash, slash. */
const Underlying = Schema.String.check(Schema.isPattern(/^[A-Z0-9][A-Z0-9./-]{0,15}$/));
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

export const OptionExpirationsArgs = Schema.Struct({ mode: Mode, underlying: Underlying });
export type OptionExpirationsArgs = typeof OptionExpirationsArgs.Type;

export const OptionChainArgs = Schema.Struct({
  mode: Mode,
  underlying: Underlying,
  expiration: IsoDate,
});
export type OptionChainArgs = typeof OptionChainArgs.Type;

export const OptionContractArgs = Schema.Struct({ mode: Mode, symbol: Symbol });
export type OptionContractArgs = typeof OptionContractArgs.Type;

/** Calendar day in New York (YYYY-MM-DD), the unit the history screen filters by. */
const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(isCalendarDay),
);

/**
 * One page of the client's orders. `cursor` is the opaque `nextCursor` of the previous page;
 * filters narrow what is listed and never widen it past this client's own rows.
 */
export const HistoryArgs = Schema.Struct({
  mode: Mode,
  accountId: Schema.optionalKey(Id),
  symbol: Schema.optionalKey(Symbol),
  /** Only orders in this lifecycle state. */
  state: Schema.optionalKey(Schema.Literals(ORDER_STATES)),
  /** Only events of this level (the admin's errors view); the client screen never sets it. */
  level: Schema.optionalKey(Schema.Literal("error")),
  from: Schema.optionalKey(Day),
  to: Schema.optionalKey(Day),
  cursor: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{1,16}:[A-Za-z0-9_-]{1,64}$/)),
  ),
});
export type HistoryArgs = typeof HistoryArgs.Type;

/** `state` and `connection` only need the mode they are asked about. */
export const ModeOnlyArgs = Schema.Struct({ mode: Mode });
export type ModeOnlyArgs = typeof ModeOnlyArgs.Type;

const token = (max: number) => Schema.String.check(Schema.isPattern(new RegExp(`^\\S{1,${max}}$`)));
/** The `redirect_uri` for authorize and exchange; the web Worker is its one source (decision D35). */
const RedirectUri = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/conexion\/callback)?$/),
);

/** The only place the client's secret travels after the form: straight into the engine. */
export const BeginConnectionArgs = Schema.Struct({
  mode: Mode,
  clientId: token(128),
  clientSecret: token(256),
  redirectUri: RedirectUri,
});
export type BeginConnectionArgs = typeof BeginConnectionArgs.Type;

export const CompleteConnectionArgs = Schema.Struct({
  mode: Mode,
  code: token(2048),
  state: token(128),
  redirectUri: RedirectUri,
});
export type CompleteConnectionArgs = typeof CompleteConnectionArgs.Type;

/** Stable codes; the web Worker maps them to Spanish copy. Details go to the events table only. */
export type EngineErrorCode =
  | "INVALID_INPUT"
  | "MODE_NOT_SIM"
  | "NOT_IMPLEMENTED"
  | "NOT_FOUND"
  | "CREDENTIALS_UNAVAILABLE"
  | "STATE_INVALID"
  | "TOKEN_EXCHANGE_FAILED"
  | "BROKER_UNAVAILABLE"
  | "INVALID_BROKER_RESPONSE";

export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EngineErrorCode; readonly message: string };

const MESSAGES: Record<EngineErrorCode, string> = {
  INVALID_INPUT: "Los datos enviados no son válidos.",
  MODE_NOT_SIM: "Solo el modo SIM está disponible.",
  NOT_IMPLEMENTED: "Esta operación todavía no está disponible.",
  NOT_FOUND: "No encontramos eso en TradeStation.",
  CREDENTIALS_UNAVAILABLE: "No pudimos guardar tus credenciales. Avisa al administrador.",
  STATE_INVALID: "El enlace de autorización no es válido o venció. Vuelve a conectar.",
  TOKEN_EXCHANGE_FAILED:
    "TradeStation rechazó la autorización. Revisa tu API key, tu secreto y la URL de callback.",
  BROKER_UNAVAILABLE: "No pudimos comunicarnos con TradeStation. Inténtalo de nuevo.",
  INVALID_BROKER_RESPONSE: "TradeStation respondió algo inesperado. Inténtalo de nuevo.",
};

export function failure(code: EngineErrorCode): EngineResult<never> {
  return { ok: false, code, message: MESSAGES[code] };
}

export function success<T>(value: T): EngineResult<T> {
  return { ok: true, value };
}

export type Decoded<A> =
  | { readonly ok: true; readonly args: A }
  | { readonly ok: false; readonly code: "INVALID_INPUT" | "MODE_NOT_SIM" };

/** Unknown fields are rejected; REAL decodes but never passes (docs/architecture.md#responsibilities). */
export function decodeArgs<
  S extends Schema.Top & {
    readonly DecodingServices: never;
    readonly Type: { readonly mode: Mode };
  },
>(schema: S, input: unknown): Decoded<S["Type"]> {
  // REAL is rejected before the rest of the arguments are looked at, whatever else is wrong.
  const requested = Schema.decodeUnknownResult(ModeOnlyArgs)(input);
  if (requested._tag === "Success" && requested.success.mode !== "SIM") {
    return { ok: false, code: "MODE_NOT_SIM" };
  }
  const result = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);
  if (result._tag === "Failure") return { ok: false, code: "INVALID_INPUT" };
  const args = result.success;
  if (args.mode !== "SIM") return { ok: false, code: "MODE_NOT_SIM" };
  return { ok: true, args };
}
