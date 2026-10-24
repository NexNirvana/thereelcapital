import { randomUUID } from "node:crypto";
import { expect, test } from "./test.ts";
import {
  count,
  d1,
  registerPasskey,
  seedSignedInUser,
  virtualAuthenticator,
  origin,
} from "./support.ts";

test.beforeEach(async ({ context }) => {
  const ip = `10.7.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
});

// Issue #104 item 1: Better Auth's own admin API answers any admin session with no fresh-session
// check and no audit row, so none of it is reachable over HTTP. The app calls it only in-process.
test("keeps every Better Auth admin endpoint closed, even to an admin session", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context, { role: "admin" });
  const rogue = `${randomUUID()}@example.com`;
  const calls: [string, string, object?][] = [
    ["POST", "/api/auth/admin/create-user", { email: rogue, name: "Rogue", role: "admin" }],
    ["POST", "/api/auth/admin/set-role", { userId: "x", role: "admin" }],
    ["POST", "/api/auth/admin/ban-user", { userId: "x" }],
    ["POST", "/api/auth/admin/unban-user", { userId: "x" }],
    ["POST", "/api/auth/admin/remove-user", { userId: "x" }],
    ["POST", "/api/auth/admin/revoke-user-sessions", { userId: "x" }],
    ["POST", "/api/auth/admin/update-user", { userId: "x", data: {} }],
    ["GET", "/api/auth/admin/list-users"],
    ["GET", "/api/auth/admin/get-user?id=x"],
    ["POST", "/api/auth/admin/some-future-endpoint", {}],
    // Core endpoints the app never calls are closed too.
    ["POST", "/api/auth/update-user", { name: "x" }],
    ["POST", "/api/auth/delete-user", {}],
  ];
  for (const [method, path, data] of calls) {
    const response = await page.request.fetch(path, { method, data, headers: { origin } });
    expect(response.status(), `${method} ${path}`).toBe(404);
  }
  expect(count(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = '${rogue}'`)).toBe(0);
});

test("keeps the endpoints the app uses reachable", async ({ page }) => {
  expect((await page.request.get("/api/auth/get-session")).status()).toBe(200);
});

// D43: a browser holding the cached session copy keeps reading for up to 30 s after its session is
// deleted, but a request that changes state is refused at once (hooks.server.ts and the
// session-cache-policy plugin).
test("refuses mutations at once for a revoked session that still has a cached copy", async ({
  context,
  page,
}) => {
  const userId = await seedSignedInUser(context);
  expect((await page.request.get("/api/auth/get-session")).status()).toBe(200);
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name.endsWith("session_data"))).toBe(true);

  d1(`DELETE FROM "session" WHERE "userId" = '${userId}'`);

  const read = await (await page.request.get("/api/auth/get-session")).json();
  expect(read.user.id).toBe(userId);
  const post = await page.request.post("/api/recovery-codes", { headers: { origin } });
  expect(post.status()).toBe(401);
  const options = await page.request.get("/api/auth/passkey/generate-register-options");
  expect(options.status()).toBe(401);
});

// Issue #104 item 2: passkey changes are sensitive actions, so a stale session (older than the
// 10-minute window) must sign in again with a passkey first.
test("asks a stale session to re-authenticate before changing passkeys", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context, { sessionAgeMs: 20 * 60_000 });
  const passkeyId = randomUUID();
  d1(
    `INSERT INTO "passkey" ("id","name","publicKey","userId","credentialID","counter","deviceType","backedUp")
     VALUES ('${passkeyId}','Antes','k','${userId}','${randomUUID()}',0,'singleDevice',0)`,
  );
  const reauth = { status: 401, code: "REAUTH_REQUIRED" };
  const send = async (method: string, path: string, data?: object) => {
    const response = await page.request.fetch(path, { method, data, headers: { origin } });
    const body = await response.json().catch(() => null);
    return { status: response.status(), code: body?.code ?? null };
  };

  expect(await send("POST", "/api/auth/passkey/delete-passkey", { id: passkeyId })).toEqual(reauth);
  expect(
    await send("POST", "/api/auth/passkey/update-passkey", { id: passkeyId, name: "Después" }),
  ).toEqual(reauth);
  expect(await send("GET", "/api/auth/passkey/generate-register-options")).toEqual(reauth);
  expect(await send("POST", "/api/auth/passkey/verify-registration", { response: {} })).toEqual(
    reauth,
  );
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId" = '${userId}'`)).toBe(1);
});

test("lets a fresh session list, rename, register and delete passkeys", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  const listed = await page.request.get("/api/auth/passkey/list-user-passkeys");
  const [passkey] = await listed.json();
  const update = await page.request.post("/api/auth/passkey/update-passkey", {
    data: { id: passkey.id, name: "Mi llave" },
    headers: { origin },
  });
  expect(update.status()).toBe(200);
  const remove = await page.request.post("/api/auth/passkey/delete-passkey", {
    data: { id: passkey.id },
    headers: { origin },
  });
  expect(remove.status()).toBe(200);
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId" = '${userId}'`)).toBe(0);
});

// Issue #104 item 3: the shell and /admin are not anonymous pages.
test("sends anyone not signed in from the shell and /admin to /acceso", async ({ page }) => {
  for (const path of ["/", "/conexion", "/admin", "/admin/clientes/x"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/acceso$/);
  }
  // Client-side navigation fetches the loads as JSON, where a redirect is part of the payload.
  const data = await page.request.get("/operar/__data.json");
  expect(await data.text()).toContain('"type":"redirect"');
});

test("keeps /admin closed to a client", async ({ context, page }) => {
  await seedSignedInUser(context);
  expect((await page.request.get("/admin")).status()).toBe(403);
});
