// Wire-to-domain conversions shared by the TradeStation endpoints. The API sends prices and
// quantities as decimal strings (the docs say numbers may also arrive unquoted) and blank fields as
// null or omitted, so every schema accepts both. Prices become integer micro-dollars and
// quantities integers without going through floating point.

import { Effect, Schema } from "effect";
import { Unknown, type BrokerOperation } from "../broker/errors.ts";

/** A decimal that arrives as a string or, defensively, as a JSON number. */
export const WireNumber = Schema.Union([Schema.String, Schema.Number]);
export type WireNumber = typeof WireNumber.Type;

/** "Blank fields may either be included as null or omitted" (docs: HTTP requests). */
export const blankable = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

const MICROS_PER_UNIT = 1_000_000;
const MICROS_PATTERN = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;
const ROUNDED_MICROS_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;
const INTEGER_PATTERN = /^\d+(?:\.0+)?$/;

/** Decodes `input` with `schema`, failing as Unknown (never retried) when the shape is wrong. */
export const decodeWire = <S extends Schema.Top & { readonly DecodingServices: never }>(
  operation: BrokerOperation,
  schema: S,
  input: unknown,
): Effect.Effect<S["Type"], Unknown> => {
  const decoded = Schema.decodeUnknownResult(schema)(input);
  return decoded._tag === "Success"
    ? Effect.succeed(decoded.success)
    : Effect.fail(new Unknown({ operation, detail: "invalid_response" }));
};

const invalid = (operation: BrokerOperation, field: string) =>
  new Unknown({ operation, detail: `invalid_value:${field}` });

const toMicros = (
  operation: BrokerOperation,
  field: string,
  sign: string | undefined,
  whole: string | undefined,
  fraction: string,
  roundUp: boolean,
): Effect.Effect<number, Unknown> => {
  const micros =
    Number(whole) * MICROS_PER_UNIT + Number(fraction.padEnd(6, "0")) + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(micros)) return Effect.fail(invalid(operation, field));
  return Effect.succeed(sign === "-" ? -micros : micros);
};

/** "212.87" → 212_870_000. At most six decimals; anything finer is refused rather than rounded. */
export function microsOf(
  operation: BrokerOperation,
  field: string,
  value: WireNumber,
): Effect.Effect<number, Unknown> {
  const match = MICROS_PATTERN.exec(String(value).trim());
  if (match === null) return Effect.fail(invalid(operation, field));
  const [, sign, whole, fraction = ""] = match;
  return toMicros(operation, field, sign, whole, fraction, false);
}

/**
 * For prices the broker computes as an average (`FilledPrice`, position `AveragePrice`), which can
 * carry more than six decimals ("0.5733333333" after fills at two prices): "0.5733333333" →
 * 573_333, rounded half away from zero on the decimal string, never through floating point.
 * The sign, digits-only shape and safe-integer checks of `microsOf` still apply.
 */
export function averageMicrosOf(
  operation: BrokerOperation,
  field: string,
  value: WireNumber,
): Effect.Effect<number, Unknown> {
  const match = ROUNDED_MICROS_PATTERN.exec(String(value).trim());
  if (match === null) return Effect.fail(invalid(operation, field));
  const [, sign, whole, fraction = ""] = match;
  const kept = fraction.slice(0, 6);
  const roundUp = (fraction[6] ?? "0") >= "5";
  return toMicros(operation, field, sign, whole, kept, roundUp);
}

/** "10" → 10. Fractional quantities are out of scope and refused. */
export function integerOf(
  operation: BrokerOperation,
  field: string,
  value: WireNumber,
): Effect.Effect<number, Unknown> {
  const text = String(value).trim();
  if (!INTEGER_PATTERN.test(text)) return Effect.fail(invalid(operation, field));
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed)
    ? Effect.succeed(parsed)
    : Effect.fail(invalid(operation, field));
}

/** ISO timestamp → epoch milliseconds. */
export function epochOf(
  operation: BrokerOperation,
  field: string,
  value: string,
): Effect.Effect<number, Unknown> {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Effect.fail(invalid(operation, field)) : Effect.succeed(parsed);
}

/** "2021-12-17T00:00:00Z" → "2021-12-17"; expirations are calendar dates, never instants. */
export function isoDateOf(
  operation: BrokerOperation,
  field: string,
  value: string,
): Effect.Effect<string, Unknown> {
  return /^\d{4}-\d{2}-\d{2}/.test(value)
    ? Effect.succeed(value.slice(0, 10))
    : Effect.fail(invalid(operation, field));
}

/** Path segment for a symbol list: option symbols contain spaces. */
export const symbolPath = (symbols: ReadonlyArray<string>): string =>
  symbols.map((symbol) => encodeURIComponent(symbol)).join(",");

type Plain = Schema.Top & { readonly DecodingServices: never };

/**
 * Names the first field of `struct` that `input` breaks, for a diagnosis that never carries a
 * value. `item` when the input is not an object at all.
 */
export function failingField(
  struct: { readonly fields: Readonly<Record<string, Plain>> },
  input: unknown,
): string {
  if (typeof input !== "object" || input === null) return "item";
  const record = input as Record<string, unknown>;
  for (const [key, field] of Object.entries(struct.fields)) {
    const probe = Schema.Struct({ [key]: field } as Record<string, Plain>);
    const present = key in record ? { [key]: record[key] } : {};
    if (Schema.decodeUnknownResult(probe)(present)._tag === "Failure") return key;
  }
  return "item";
}
