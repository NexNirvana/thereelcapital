import { Schema } from "effect";
import { SIZE_CHOICES, type SizeChoice } from "#lib/domain/sizing.ts";

// Everything the browser may say about an entry: which tab, which account and which instrument.
// SIZE, quantity and price are not inputs: the engine reads SIZE from the client's settings and the
// ask from TradeStation (CLAUDE.md, never-break rule 3), and unknown fields are rejected.
export const EntryQuery = Schema.Struct({
  tipo: Schema.optionalKey(Schema.Literals(["acciones", "opciones"])),
  cuenta: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  simbolo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  /** The one-entry SIZE choice (D51): a closed set, never an amount. Absent means the full SIZE. */
  tamano: Schema.optionalKey(Schema.Literals(SIZE_CHOICES)),
});

/**
 * What the engine call carries for a choice. The full SIZE is left out, so an engine that predates
 * the choice keeps working for it, while a reduced one is refused by its strict decoder.
 */
export const sizeChoiceArg = (choice: SizeChoice | undefined) =>
  choice === "down25" ? ({ sizeChoice: "down25" } as const) : ({} as const);

/** The /operar page also takes the chain to show on the Opciones tab (all plain text the server validates again). */
export const OperarQuery = Schema.Struct({
  ...EntryQuery.fields,
  subyacente: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16))),
  vencimiento: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  strike: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16))),
  strikes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8))),
});

/** Equity tickers and option symbols ("MSFT 261120C400"): letters, digits, space, dot, dash, slash. */
export const SYMBOL = /^[A-Z0-9][A-Z0-9 ./-]*$/;

export const ASSET_TYPE = { acciones: "equity", opciones: "option" } as const;

/** The id `prepareEntry` returns (engine/src/rpc.ts INTENT_ID_PATTERN): 16 random bytes, base64url. */
export const INTENT_ID = /^[A-Za-z0-9_-]{22}$/;
