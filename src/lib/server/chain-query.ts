import { Schema } from "effect";

// The browser names an underlying, an expiration and (to hand it back) an account. Contract
// symbols, prices and strikes only ever come from the engine; unknown parameters are a 400.
export const ChainQuery = Schema.Struct({
  subyacente: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16))),
  vencimiento: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10))),
  cuenta: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});

export const UNDERLYING = /^[A-Z0-9][A-Z0-9./-]{0,15}$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
