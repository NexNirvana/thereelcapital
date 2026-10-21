import { error } from "@sveltejs/kit";
import { Schema } from "effect";

/**
 * Decodes form or JSON input at the boundary. Unknown fields are rejected, and the response
 * never echoes the input or the schema issues (they could contain submitted values).
 */
export function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
): S["Type"] {
  const result = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);
  if (result._tag === "Failure") {
    error(400, "Los datos enviados no son válidos.", { code: "INVALID_INPUT" });
  }
  return result.success;
}
