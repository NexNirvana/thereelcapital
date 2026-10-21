// RPC surface of the ClientCoordinator: argument schemas and the typed failure every method can
// return. Arguments never carry a client id (the DO is the client), SIZE, quantity, price or a
// broker URL (CLAUDE.md, never-break rule 3).

import { Schema } from "effect";
import { TRAILING_PCT_OPTIONS } from "#lib/domain/config.ts";
import { Mode } from "./mode.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const Symbol = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32));

export const PrepareEntryArgs = Schema.Struct({
  mode: Mode,
  accountId: Id,
  symbol: Symbol,
  assetType: Schema.Literals(["equity", "option"]),
});
export type PrepareEntryArgs = typeof PrepareEntryArgs.Type;

export const SendEntryArgs = Schema.Struct({ mode: Mode, intentId: Id });
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

/** `state`, `history` and `connection` only need the mode they are asked about. */
export const ModeOnlyArgs = Schema.Struct({ mode: Mode });
export type ModeOnlyArgs = typeof ModeOnlyArgs.Type;

/** Stable codes; the web Worker maps them to Spanish copy. Details go to the events table only. */
export type EngineErrorCode = "INVALID_INPUT" | "MODE_NOT_SIM" | "NOT_IMPLEMENTED";

export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EngineErrorCode; readonly message: string };

const MESSAGES: Record<EngineErrorCode, string> = {
  INVALID_INPUT: "Los datos enviados no son válidos.",
  MODE_NOT_SIM: "Solo el modo SIM está disponible.",
  NOT_IMPLEMENTED: "Esta operación todavía no está disponible.",
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
