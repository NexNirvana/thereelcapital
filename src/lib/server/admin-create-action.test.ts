import { describe, expect, mock, test } from "bun:test";
import { createAuth } from "./auth.ts";
import { sharedAuth } from "./shared-auth.ts";
import { countingD1, APP_ORIGIN } from "./counting-d1.test.ts";

// The route module reads its bindings from `cloudflare:workers`; the mock points them at a
// counting D1 that each test replaces (issue #243).
let current = countingD1();
void mock.module("cloudflare:workers", () => ({
  env: new Proxy({}, { get: (_target, key) => Reflect.get(current.env, key) }),
}));
const { actions } = await import("../../routes/admin/+page.server.ts");

async function runCreate(email: string) {
  const form = new FormData();
  form.set("email", email);
  const { sqlite, env } = current;
  const now = Date.now();
  sqlite.run(
    `INSERT INTO "user" ("id","name","email","emailVerified","role","createdAt","updatedAt")
     VALUES ('admin-1','a','admin@example.test',1,'admin',?,?)`,
    [now, now],
  );
  // The hook's instance for this isolate, warmed the way a request would.
  const auth = sharedAuth(env, () => createAuth(env));
  await auth.api.getSession({ headers: new Headers() });
  const warm = current.statements.length;

  const event = {
    request: new Request(`${APP_ORIGIN}/admin?/create`, { method: "POST", body: form }),
    setHeaders: () => {},
    locals: {
      auth,
      session: { createdAt: new Date() },
      user: { id: "admin-1", role: "admin", banned: false },
    },
  };
  // @ts-expect-error the action only reads these fields of the SvelteKit event
  const result = await actions.create(event);
  return { result, statements: current.statements.slice(warm) };
}

describe("admin create-client action", () => {
  test("creates the client on the request's shared auth instance, not a new one", async () => {
    current = countingD1();
    const { result, statements } = await runCreate("new@example.test");
    expect(result).toMatchObject({ created: { email: "new@example.test" } });
    // Building another instance runs its schema check again (a dozen introspection statements).
    expect(statements.filter((sql) => /pragma|sqlite_master|table_info/i.test(sql))).toEqual([]);
    expect(statements.length).toBeLessThan(12);
  });
});
