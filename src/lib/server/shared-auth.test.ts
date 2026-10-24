import { describe, expect, test } from "bun:test";
import { serializeSignedCookie } from "better-call";
import { createAuth, type Auth, type AuthEnv } from "./auth.ts";
import { sharedAuth } from "./shared-auth.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

const SECRET = "s".repeat(40);
const APP_ORIGIN = "https://thereelcapital.com";

// A D1-shaped database over the real migrations that counts the statements it runs.
function countingD1() {
  const base = sqliteD1();
  const statements: string[] = [];
  const DB = {
    prepare: (sql: string) => {
      statements.push(sql);
      const statement = base.prepare(sql);
      return {
        bind: (...bindings: never[]) => {
          const bound = statement.bind(...bindings);
          return {
            ...bound,
            all: async () => ({ results: (await bound.all()).results, meta: { changes: 0 } }),
          };
        },
      };
    },
    batch: base.batch,
    exec: async () => ({}),
  };
  return {
    sqlite: base.sqlite,
    statements,
    env: { DB, BETTER_AUTH_SECRET: SECRET, APP_ORIGIN } as unknown as AuthEnv,
  };
}

async function signedIn(auth: Auth, name: string) {
  const { internalAdapter, authCookies } = await auth.$context;
  const user = await internalAdapter.createUser(
    {
      name,
      email: `${name}@example.test`,
      emailVerified: true,
    },
    { method: "admin" },
  );
  const session = await internalAdapter.createSession(user.id);
  const cookie = await serializeSignedCookie(authCookies.sessionToken.name, session.token, SECRET);
  return { user, session, headers: new Headers({ cookie: cookie.split(";")[0] ?? "" }) };
}

describe("shared auth instance", () => {
  test("is built once per binding, secret and origin", () => {
    const { env } = countingD1();
    let builds = 0;
    const build = () => (builds++, createAuth(env));
    const first = sharedAuth(env, build);
    expect(sharedAuth(env, build)).toBe(first);
    expect(builds).toBe(1);

    const other = countingD1().env;
    expect(sharedAuth(other, () => createAuth(other))).not.toBe(first);
    const rotated = { ...env, BETTER_AUTH_SECRET: "r".repeat(40) };
    expect(sharedAuth(rotated, () => createAuth(rotated))).not.toBe(first);
    const moved = { ...env, APP_ORIGIN: "http://localhost:8787" };
    expect(sharedAuth(moved, () => createAuth(moved))).not.toBe(first);
  });

  test("does not run the schema check again on every request", async () => {
    const shared = countingD1();
    const auth = sharedAuth(shared.env, () => createAuth(shared.env));
    await auth.api.getSession({ headers: new Headers() });
    const afterFirst = shared.statements.length;
    for (let i = 0; i < 5; i++)
      await sharedAuth(shared.env, () => createAuth(shared.env)).api.getSession({
        headers: new Headers(),
      });
    expect(shared.statements.length).toBe(afterFirst);

    const fresh = countingD1();
    for (let i = 0; i < 3; i++)
      await createAuth(fresh.env).api.getSession({ headers: new Headers() });
    expect(fresh.statements.length).toBeGreaterThan(afterFirst * 2);
  });

  test("keeps users, cookies and headers of concurrent requests apart", async () => {
    const { env } = countingD1();
    const auth = sharedAuth(env, () => createAuth(env));
    const [ana, ben] = [await signedIn(auth, "ana"), await signedIn(auth, "ben")];

    const results = await Promise.all(
      [ana, ben, ana, ben, { headers: new Headers() }].map((who) =>
        auth.api.getSession({ headers: who.headers, returnHeaders: true }),
      ),
    );
    expect(results.map((r) => r.response?.user.id ?? null)).toEqual([
      ana.user.id,
      ben.user.id,
      ana.user.id,
      ben.user.id,
      null,
    ]);
    expect(results[4]?.headers.get("set-cookie")).toBeNull();
  });

  test("a revoked session stops resolving on the very next request", async () => {
    const { env } = countingD1();
    const auth = sharedAuth(env, () => createAuth(env));
    const ana = await signedIn(auth, "ana");
    expect((await auth.api.getSession({ headers: ana.headers }))?.user.id).toBe(ana.user.id);
    await (await auth.$context).internalAdapter.deleteSession(ana.session.token);
    expect(await auth.api.getSession({ headers: ana.headers })).toBeNull();
  });

  test("a ban is seen on the very next request", async () => {
    const { env, sqlite } = countingD1();
    const auth = sharedAuth(env, () => createAuth(env));
    const ana = await signedIn(auth, "ana");
    expect((await auth.api.getSession({ headers: ana.headers }))?.user.banned).toBeFalsy();
    sqlite.run(`UPDATE "user" SET "banned" = 1 WHERE "id" = ?`, [ana.user.id]);
    expect((await auth.api.getSession({ headers: ana.headers }))?.user.banned).toBe(true);
  });

  test("a failed init is not kept for later requests", async () => {
    const { env } = countingD1();
    const broken = {
      ...createAuth(env),
      $context: Promise.reject(new Error("init failed")),
    } as Auth;
    sharedAuth(env, () => broken);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const good = createAuth(env);
    expect(sharedAuth(env, () => good)).toBe(good);
  });
});
