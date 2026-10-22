// Test-only seeding of a client's Durable Object, used by the e2e specs through the web Worker's
// /api/test/seed route. It runs inside the object, so the engine stays the only writer of its
// own storage (a second process writing the SQLite file races it). Refused unless ENVIRONMENT is
// "development" or "test" (docs/test-plan.md); it never touches the broker.
import { Schema } from "effect";
import { allowsTestAffordances } from "#lib/domain/environment.ts";

const Statement = Schema.Struct({
  sql: Schema.String,
  params: Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
});
export const SeedStatements = Schema.Array(Statement);

export type SeedResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function seedForTest(
  environment: string | undefined,
  storage: DurableObjectStorage,
  input: unknown,
): SeedResult {
  if (!allowsTestAffordances(environment)) return { ok: false, reason: "NOT_AVAILABLE" };
  const decoded = Schema.decodeUnknownResult(SeedStatements)(input);
  if (decoded._tag === "Failure") return { ok: false, reason: "INVALID_INPUT" };
  storage.transactionSync(() => {
    for (const { sql, params } of decoded.success) storage.sql.exec(sql, ...params);
  });
  return { ok: true };
}
