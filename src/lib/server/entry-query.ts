import { Schema } from "effect";

// Everything the browser may say about an entry: which tab, which account and which instrument.
// SIZE, quantity and price are not inputs: the engine reads SIZE from the client's settings and the
// ask from TradeStation (CLAUDE.md, never-break rule 3), and unknown fields are rejected.
export const EntryQuery = Schema.Struct({
  tipo: Schema.optionalKey(Schema.Literals(["acciones", "opciones"])),
  cuenta: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  simbolo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
});

/** Equity tickers and option symbols ("MSFT 261120C400"): letters, digits, space, dot, dash, slash. */
export const SYMBOL = /^[A-Z0-9][A-Z0-9 ./-]*$/;

export const ASSET_TYPE = { acciones: "equity", opciones: "option" } as const;

/** The id `prepareEntry` returns (engine/src/rpc.ts INTENT_ID_PATTERN): 16 random bytes, base64url. */
export const INTENT_ID = /^[A-Za-z0-9_-]{22}$/;
