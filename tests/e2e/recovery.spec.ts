import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type BrowserContext, type Page } from "@playwright/test";
import { hashToken } from "../../src/lib/server/token-hash.ts";
import { newRecoveryCode, normalizeRecoveryCode } from "../../src/lib/server/recovery-codes.ts";
import {
  authSecret,
  count,
  d1,
  registerPasskey,
  seedSignedInUser,
  virtualAuthenticator,
} from "./support.ts";

// Each test gets its own client IP: the redeem endpoint is rate limited per IP (cf-connecting-ip),
// so tests must not share a bucket.
test.beforeEach(async ({ context }) => {
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({
    "cf-connecting-ip": ip,
    // Browsers always send it on POST; Better Auth refuses cookie-bearing requests without it.
    origin: "http://localhost:8790",
  });
});

async function seedCodes(userId: string, howMany = 3) {
  const codes = Array.from({ length: howMany }, newRecoveryCode);
  for (const code of codes) {
    const hash = await hashToken("recovery-code", normalizeRecoveryCode(code), authSecret);
    d1(
      `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('${randomUUID()}','${userId}','${hash}')`,
    );
  }
  return codes;
}

const redeem = (page: Page, code: string) =>
  page.request.post("/api/auth/recovery/redeem", { data: { code } });
const sessionOf = async (page: Page) => (await page.request.get("/api/auth/get-session")).json();
const sessionCount = (userId: string) =>
  count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = '${userId}'`);
const hasSessionCookie = (response: APIResponse) =>
  response
    .headersArray()
    .some(
      (header) =>
        header.name.toLowerCase() === "set-cookie" && header.value.includes("session_token"),
    );

// A client with a session, a registered passkey and recovery codes; the browser then loses its
// session, as after losing the device.
async function clientWithCodes(context: BrowserContext, page: Page) {
  await page.goto("/acceso");
  const authenticator = await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  return { userId, authenticator, codes: await seedCodes(userId) };
}

test("rejects a wrong code without creating a session", async ({ page }) => {
  await page.goto("/acceso");
  const response = await redeem(page, newRecoveryCode());
  expect(response.status()).toBe(401);
  expect((await response.json()).code).toBe("INVALID_RECOVERY_CODE");
  expect(hasSessionCookie(response)).toBe(false);
  expect(await sessionOf(page)).toBeNull();
});

test("rejects unknown fields and malformed input", async ({ page }) => {
  await page.goto("/acceso");
  for (const data of [{ code: "x", extra: 1 }, {}, { code: 5 }, { code: "A".repeat(65) }]) {
    const response = await page.request.post("/api/auth/recovery/redeem", { data });
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe("INVALID_INPUT");
  }
});

test("a code works once, revokes every session and opens an enrollment session", async ({
  context,
  page,
}) => {
  const { userId, codes } = await clientWithCodes(context, page);
  const [code, other] = codes;
  expect(sessionCount(userId)).toBe(1);
  const otherDevice = randomUUID();
  const now = new Date().toISOString();
  d1(
    `INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId")
     VALUES ('${randomUUID()}','${new Date(Date.now() + 3_600_000).toISOString()}','${otherDevice}','${now}','${now}','${userId}')`,
  );
  expect(sessionCount(userId)).toBe(2);

  const response = await redeem(page, (code ?? "").toLowerCase());
  expect(response.status()).toBe(200);
  // Both earlier sessions are gone; only the enrollment session remains.
  expect(
    count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId"='${userId}' AND "enrollment"=1`),
  ).toBe(1);
  expect(sessionCount(userId)).toBe(1);
  expect((await sessionOf(page)).session.enrollment).toBe(true);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='recovery.redeem' AND actor_id='${userId}'`,
    ),
  ).toBe(1);

  // The same code again, and from a client with no cookies, is rejected and creates nothing.
  await context.clearCookies();
  const again = await redeem(page, code ?? "");
  expect(again.status()).toBe(401);
  expect(hasSessionCookie(again)).toBe(false);
  expect(sessionCount(userId)).toBe(1);
  // Another unused code still works: only the redeemed one is spent.
  expect((await redeem(page, other ?? "")).status()).toBe(200);
});

test("concurrent redemption of one code succeeds exactly once", async ({ context, page }) => {
  const { userId, codes } = await clientWithCodes(context, page);
  await context.clearCookies();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => redeem(page, codes[0] ?? "")),
  );
  expect(responses.map((response) => response.status()).sort()).toEqual([200, 401, 401, 401]);
  expect(
    count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId"='${userId}' AND "enrollment"=1`),
  ).toBe(1);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id='${userId}' AND used_at IS NOT NULL`,
    ),
  ).toBe(1);
});

test("recoveries racing on different codes leave at most one session", async ({
  context,
  page,
}) => {
  const { userId, codes } = await clientWithCodes(context, page);
  await context.clearCookies();
  const responses = await Promise.all([redeem(page, codes[0] ?? ""), redeem(page, codes[1] ?? "")]);
  expect(responses.map((response) => response.status())).toEqual([200, 200]);
  expect(sessionCount(userId)).toBeLessThanOrEqual(1);
});

test("a suspended client's code is rejected and stays unused", async ({ context, page }) => {
  const { userId, codes } = await clientWithCodes(context, page);
  d1(`UPDATE "user" SET "banned" = 1 WHERE "id" = '${userId}'`);
  await context.clearCookies();
  const response = await redeem(page, codes[0] ?? "");
  expect(response.status()).toBe(401);
  expect(hasSessionCookie(response)).toBe(false);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id='${userId}' AND used_at IS NOT NULL`,
    ),
  ).toBe(0);
});

test("rate limits redemption attempts per IP", async ({ page }) => {
  await page.goto("/acceso");
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    statuses.push((await redeem(page, newRecoveryCode())).status());
  }
  expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
  expect(statuses.slice(5)).toEqual([429, 429]);
});

test("an enrollment session cannot reach anything but passkey registration", async ({
  context,
  page,
}) => {
  const { userId, codes, authenticator } = await clientWithCodes(context, page);
  await authenticator.forgetCredentials();
  await context.clearCookies();
  expect((await redeem(page, codes[0] ?? "")).status()).toBe(200);

  // Pages: the trading page redirects back to the recovery screen.
  const home = await page.request.get("/", { maxRedirects: 0 });
  expect([home.status(), home.headers().location]).toEqual([303, "/recuperacion"]);

  // The sign-in page stays reachable (the recovery screen links to it).
  expect((await page.request.get("/acceso", { maxRedirects: 0 })).status()).toBe(200);

  const refused = [
    await page.request.get("/api/auth/passkey/list-user-passkeys"),
    await page.request.post("/api/auth/passkey/delete-passkey", { data: { id: "x" } }),
    await page.request.post("/api/auth/revoke-sessions", { data: {} }),
    await page.request.post("/api/auth/update-user", { data: { name: "otro" } }),
    await page.request.get("/api/auth/admin/list-users"),
    await page.request.post("/api/recovery-codes", { data: {} }),
  ];
  for (const response of refused) {
    expect(response.status()).toBe(403);
    expect((await response.json()).code).toBe("ENROLLMENT_ONLY");
  }
  // It is signed out as far as the app is concerned, and passkey registration still works.
  await page.goto("/recuperacion");
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  // The old passkey was deleted at redemption, so the new one is the only one.
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId"='${userId}'`)).toBe(1);
});

test("an expired enrollment session can do nothing, not even register", async ({
  context,
  page,
}) => {
  const { userId, codes } = await clientWithCodes(context, page);
  await context.clearCookies();
  expect((await redeem(page, codes[0] ?? "")).status()).toBe(200);
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
  d1(`UPDATE "session" SET "createdAt" = '${twentyMinutesAgo}' WHERE "userId" = '${userId}'`);

  for (const response of [
    await page.request.get("/api/auth/passkey/generate-register-options"),
    await page.request.post("/api/auth/enrollment/complete", { data: {} }),
  ]) {
    expect(response.status()).toBe(401);
    expect((await response.json()).code).toBe("ENROLLMENT_EXPIRED");
  }
});

test("an expired enrollment session still lets the client sign in with the new passkey", async ({
  context,
  page,
}) => {
  const { userId, codes, authenticator } = await clientWithCodes(context, page);
  await authenticator.forgetCredentials();
  await context.clearCookies();
  expect((await redeem(page, codes[0] ?? "")).status()).toBe(200);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
  d1(`UPDATE "session" SET "createdAt" = '${twentyMinutesAgo}' WHERE "userId" = '${userId}'`);

  await page.goto("/acceso");
  await page.getByRole("button", { name: "Entrar con passkey" }).click();
  await expect(page).toHaveURL("/");
  expect((await sessionOf(page)).session.enrollment).toBe(false);
});

test("redeeming a code deletes the old passkeys so they can no longer sign in", async ({
  context,
  page,
}) => {
  const { userId, codes } = await clientWithCodes(context, page);
  // Another client with a passkey, a session and a code of their own.
  const other = await seedSignedInUser(context);
  d1(
    `INSERT INTO "passkey" ("id","publicKey","userId","credentialID","counter","deviceType","backedUp")
     VALUES ('${randomUUID()}','pk','${other}','${randomUUID()}',0,'singleDevice',0)`,
  );
  const [otherCode] = await seedCodes(other, 1);
  await context.clearCookies();

  expect((await redeem(page, codes[0] ?? "")).status()).toBe(200);
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId"='${userId}'`)).toBe(0);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='recovery.passkeys_delete' AND target_user_id='${userId}' AND before_json='{"count":1}'`,
    ),
  ).toBe(1);
  // The other client keeps everything, including their unused code.
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId"='${other}'`)).toBe(1);
  expect(
    count(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id='${other}' AND used_at IS NULL`),
  ).toBe(1);
  expect(otherCode).toBeDefined();

  // The authenticator still holds the old credential, but the server no longer knows it.
  await context.clearCookies();
  await page.goto("/acceso");
  const verification = page.waitForResponse("**/api/auth/passkey/verify-authentication");
  await page.getByRole("button", { name: "Entrar con passkey" }).click();
  expect((await verification).ok()).toBe(false);
  await expect(page).not.toHaveURL("/");
  expect(await sessionOf(page)).toBeNull();
  expect(
    count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId"='${userId}' AND "enrollment"=0`),
  ).toBe(0);
});

test("an interrupted recovery can be retried with another unused code", async ({
  context,
  page,
}) => {
  const { userId, codes } = await clientWithCodes(context, page);
  await context.clearCookies();
  expect((await redeem(page, codes[0] ?? "")).status()).toBe(200);
  // The client never registers a passkey and the enrollment session lapses.
  await context.clearCookies();
  expect((await redeem(page, codes[1] ?? "")).status()).toBe(200);
  expect(
    count(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id='${userId}' AND used_at IS NULL`),
  ).toBe(1);
  expect(sessionCount(userId)).toBe(1);
});

test("finishing needs a new passkey, then returns a full session and ten fresh codes", async ({
  context,
  page,
}) => {
  const { userId, codes, authenticator } = await clientWithCodes(context, page);
  await authenticator.forgetCredentials();
  await context.clearCookies();
  expect((await redeem(page, codes[0] ?? "")).status()).toBe(200);

  const early = await page.request.post("/api/auth/enrollment/complete", { data: {} });
  expect(early.status()).toBe(403);
  expect((await early.json()).code).toBe("PASSKEY_REQUIRED");

  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  const done = await page.request.post("/api/auth/enrollment/complete", { data: {} });
  expect(done.status()).toBe(200);
  expect(done.headers()["cache-control"]).toBe("no-store");
  const { codes: fresh } = await done.json();
  expect(fresh).toHaveLength(10);

  expect((await sessionOf(page)).session.enrollment).toBe(false);
  expect(
    count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId"='${userId}' AND "enrollment"=1`),
  ).toBe(0);
  expect((await page.request.get("/", { maxRedirects: 0 })).status()).toBe(200);
  expect(count(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id='${userId}'`)).toBe(10);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='recovery_codes.issue' AND target_user_id='${userId}'`,
    ),
  ).toBe(1);

  // Finishing twice issues nothing more, and the old codes no longer work.
  expect((await page.request.post("/api/auth/enrollment/complete", { data: {} })).status()).toBe(
    401,
  );
  await context.clearCookies();
  expect((await redeem(page, codes[1] ?? "")).status()).toBe(401);
  expect((await redeem(page, fresh[0])).status()).toBe(200);
});

test("regenerating codes needs a fresh session and replaces the whole set", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  const userId = await seedSignedInUser(context);
  const [old] = await seedCodes(userId);

  const response = await page.request.post("/api/recovery-codes", { data: {} });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const { codes } = await response.json();
  expect(codes).toHaveLength(10);
  expect(count(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id='${userId}'`)).toBe(10);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='recovery_codes.regenerate' AND actor_id='${userId}'`,
    ),
  ).toBe(1);
  await context.clearCookies();
  expect((await redeem(page, old ?? "")).status()).toBe(401);

  // The same session once it is 11 minutes old is no longer fresh.
  const stale = await seedSignedInUser(context);
  d1(
    `UPDATE "session" SET "createdAt" = '${new Date(Date.now() - 11 * 60_000).toISOString()}' WHERE "userId" = '${stale}'`,
  );
  const refused = await page.request.post("/api/recovery-codes", { data: {} });
  expect(refused.status()).toBe(401);
  expect((await refused.json()).code).toBe("REAUTH_REQUIRED");
  expect(count(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id='${stale}'`)).toBe(0);
});
