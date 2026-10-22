// Test-only seeding for the e2e specs: they write fixture rows through the running app instead of
// a second process opening the dev server's SQLite files (which raced its locks). Available only
// where ENVIRONMENT is "development" or "test"; any other value answers 404 as if the route did
// not exist. It never touches the broker.
import { error, json } from "@sveltejs/kit";
import { Schema } from "effect";
import { allowsTestAffordances } from "#lib/domain/environment.ts";
import { decode } from "./decode.ts";

const Param = Schema.Union([Schema.String, Schema.Number, Schema.Null]);

const SeedBody = Schema.Union([
  Schema.Struct({ target: Schema.Literal("d1"), statements: Schema.Array(Schema.String) }),
  Schema.Struct({
    target: Schema.Literal("engine"),
    clientId: Schema.String,
    statements: Schema.Array(Schema.Struct({ sql: Schema.String, params: Schema.Array(Param) })),
  }),
]);

export interface SeedDeps {
  readonly environment: string | undefined;
  readonly db: {
    prepare(sql: string): { bind(): { all(): Promise<{ results: unknown[] }> } };
    batch(
      statements: ReturnType<ReturnType<SeedDeps["db"]["prepare"]>["bind"]>[],
    ): Promise<{ results: unknown[] }[]>;
  };
  readonly engine: {
    getByName(name: string): { seedForTest(statements: unknown): Promise<{ ok: boolean }> };
  };
}

export async function handleSeed(deps: SeedDeps, body: unknown): Promise<Response> {
  if (!allowsTestAffordances(deps.environment)) error(404, "Not Found");
  const request = decode(SeedBody, body);
  if (request.target === "engine") {
    const result = await deps.engine.getByName(request.clientId).seedForTest(request.statements);
    return json(result, { status: result.ok ? 200 : 400 });
  }
  // One batch is one transaction, so a multi-statement seed lands whole or not at all. The rows
  // returned are the last statement's, which is the SELECT when a helper reads.
  const results = await deps.db.batch(request.statements.map((sql) => deps.db.prepare(sql).bind()));
  return json({ results: results.at(-1)?.results ?? [] });
}
