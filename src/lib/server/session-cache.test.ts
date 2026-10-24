import { afterEach, describe, expect, test, setSystemTime } from "bun:test";
import { serializeSignedCookie } from "better-call";
import { SESSION_COOKIE_CACHE_SECONDS } from "#lib/domain/config.ts";
import { createAuth } from "./auth.ts";
import { countingD1, APP_ORIGIN, SECRET } from "./counting-d1.test.ts";
import {
  mayUseSessionCache,
  sessionCachePolicyPlugin,
  withoutSessionCache,
} from "./session-cache.ts";

afterEach(() => setSystemTime());

async function setup(enrollment = false) {
  const shared = countingD1();
  const auth = createAuth(shared.env);
  const { internalAdapter, authCookies } = await auth.$context;
  const user = await internalAdapter.createUser(
    { name: "ana", email: "ana@example.test", emailVerified: true },
    { method: "admin" },
  );
  const session = await internalAdapter.createSession(user.id);
  if (enrollment) shared.sqlite.run(`UPDATE "session" SET "enrollment" = 1`);
  const token = (
    await serializeSignedCookie(authCookies.sessionToken.name, session.token, SECRET)
  ).split(";")[0];
  const read = async (cookie: string, disableCookieCache = false) =>
    auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache },
      returnHeaders: true,
    });
  // The first read goes to D1 and hands back the cached copy, as a browser would keep it.
  const first = await read(token ?? "");
  const copy = first.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .filter((pair) => pair?.includes("session_data"))
    .join("; ");
  return { ...shared, auth, user, session, read, first, cookie: `${token}; ${copy}`, authCookies };
}

describe("session cookie cache", () => {
  test("the window is the configured 30 seconds", () => {
    expect(SESSION_COOKIE_CACHE_SECONDS).toBe(30);
  });

  test("an authenticated read costs 2 D1 statements uncached and none with the cached copy", async () => {
    const t = await setup();
    expect(t.first.response?.user.id).toBe(t.user.id);
    t.statements.length = 0;
    await t.read(t.cookie.split("; ")[0] ?? "");
    expect(t.statements.length).toBe(2);
    t.statements.length = 0;
    for (let i = 0; i < 5; i++) expect((await t.read(t.cookie)).response?.user.id).toBe(t.user.id);
    expect(t.statements.length).toBe(0);
  });

  test("the copy carries the enrollment flag, so the enrollment gate still sees it", async () => {
    const t = await setup(true);
    expect((await t.read(t.cookie)).response?.session.enrollment).toBe(true);
  });

  test("a banned user is still served for 30 seconds and refused after", async () => {
    const t = await setup();
    t.sqlite.run(`UPDATE "user" SET "banned" = 1`);
    expect((await t.read(t.cookie)).response?.user.banned).toBeFalsy();
    setSystemTime(new Date(Date.now() + (SESSION_COOKIE_CACHE_SECONDS + 1) * 1000));
    // The copy is stale: Better Auth drops it and reads D1 (the banned flag is now visible).
    expect((await t.read(t.cookie)).response?.user.banned).toBe(true);
  });

  test("a revoked session is served from the copy for 30 seconds, never when D1 is asked", async () => {
    const t = await setup();
    t.sqlite.run(`DELETE FROM "session"`);
    expect((await t.read(t.cookie)).response?.user.id).toBe(t.user.id);
    expect((await t.read(t.cookie, true)).response).toBeNull();
    setSystemTime(new Date(Date.now() + (SESSION_COOKIE_CACHE_SECONDS + 1) * 1000));
    expect((await t.read(t.cookie)).response).toBeNull();
  });

  test("a mutating auth request ignores the copy: a revoked session cannot reach passkey setup", async () => {
    const t = await setup();
    t.sqlite.run(`DELETE FROM "session"`);
    const call = (method: string, path: string) =>
      t.auth.handler(
        new Request(`${APP_ORIGIN}/api/auth${path}`, {
          method,
          headers: { cookie: t.cookie, origin: APP_ORIGIN, "content-type": "application/json" },
          body: method === "POST" ? "{}" : undefined,
        }),
      );
    expect((await call("GET", "/get-session")).status).toBe(200);
    expect((await call("GET", "/passkey/generate-register-options")).status).toBe(401);
  });

  test("own sign-out is immediate: it expires the copy along with the session", async () => {
    const t = await setup();
    const response = await t.auth.handler(
      new Request(`${APP_ORIGIN}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie: t.cookie, origin: APP_ORIGIN, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    const cleared = response.headers.getSetCookie().filter((line) => /Max-Age=0/i.test(line));
    expect(cleared.some((line) => line.includes("session_data"))).toBe(true);
    expect(t.sqlite.query(`SELECT COUNT(*) AS n FROM "session"`).get()).toEqual({ n: 0 });
  });
});

describe("which requests may use the copy", () => {
  test("only reads, and not the connect callback", () => {
    expect(mayUseSessionCache("GET", "/operar")).toBe(true);
    expect(mayUseSessionCache("HEAD", "/operar")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(mayUseSessionCache(method, "/operar")).toBe(false);
    expect(mayUseSessionCache("GET", "/conexion/callback")).toBe(false);
    expect(mayUseSessionCache("GET", "/api/auth/get-session")).toBe(true);
    expect(mayUseSessionCache("GET", "/api/auth/passkey/generate-register-options")).toBe(false);
  });

  test("withoutSessionCache drops the copy and its chunks and keeps the rest", () => {
    expect(
      withoutSessionCache(
        "a=1; __Secure-better-auth.session_token=t; __Secure-better-auth.session_data=d; better-auth.session_data.0=x; b=2",
      ),
    ).toBe("a=1; __Secure-better-auth.session_token=t; b=2");
    expect(withoutSessionCache("better-auth.session_data=d")).toBe("");
  });

  test("the plugin strips the copy from mutating requests only", async () => {
    const { onRequest } = sessionCachePolicyPlugin();
    const cookie = "better-auth.session_token=t; better-auth.session_data=d";
    const post = await onRequest(
      new Request("https://x.test/api/auth/sign-out", { method: "POST", headers: { cookie } }),
    );
    expect(post?.request.headers.get("cookie")).toBe("better-auth.session_token=t");
    const get = async (path: string) =>
      onRequest(new Request(`https://x.test${path}`, { headers: { cookie } }));
    expect(await get("/api/auth/get-session")).toBeUndefined();
    expect(
      (await get("/api/auth/passkey/generate-register-options"))?.request.headers.get("cookie"),
    ).toBe("better-auth.session_token=t");
  });
});
