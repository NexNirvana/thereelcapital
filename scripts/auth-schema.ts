// Config for the Better Auth CLI only (`bunx auth@latest generate`); the app builds its instance in
// src/lib/server/auth.ts. The CLI needs a database object to pick the SQLite dialect, but only
// reads the schema from the options, so an empty in-memory database is enough.
import { DatabaseSync } from "node:sqlite";
import { createAuth } from "#lib/server/auth.ts";

export const auth = createAuth({
  DB: new DatabaseSync(":memory:"),
  BETTER_AUTH_SECRET: "schema-generation-only",
  APP_ORIGIN: "http://localhost",
});
