import { randomUUID } from "node:crypto";
import { expect, test } from "./test.ts";
import { type APIResponse, type Page } from "@playwright/test";
import {
  count,
  d1,
  registerPasskey,
  resendDroppedPosts,
  seedPendingClient,
  virtualAuthenticator,
  origin,
} from "./support.ts";

// Each test gets its own client IP: opening a link is rate limited per IP (cf-connecting-ip).
test.beforeEach(async ({ context }) => {
  const ip = `10.2.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({
    "cf-connecting-ip": ip,
    // Browsers always send it on POST; Better Auth refuses cookie-bearing requests without it.
    origin: origin,
  });
});

const open = (page: Page, token: string) =>
  page.request.post("/api/auth/activation/redeem", { data: { token } });
const sessionOf = async (page: Page) => (await page.request.get("/api/auth/get-session")).json();
const hasSessionCookie = (response: APIResponse) =>
  response
    .headersArray()
    .some(
      (header) =>
        header.name.toLowerCase() === "set-cookie" && header.value.includes("session_token"),
    );
const sessionCount = (userId: string) =>
  count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = '${userId}'`);
const usedAt = (invitationId: string) =>
  count(`SELECT COUNT(*) AS n FROM invitations WHERE id='${invitationId}' AND used_at IS NOT NULL`);

async function expectRejected(page: Page, token: string, userId: string) {
  const response = await open(page, token);
  expect(response.status()).toBe(401);
  expect((await response.json()).code).toBe("INVALID_ACTIVATION_LINK");
  expect(hasSessionCookie(response)).toBe(false);
  expect(sessionCount(userId)).toBe(0);
}

test("rejects an unknown token and malformed input without creating anything", async ({ page }) => {
  await page.goto("/acceso");
  const users = count(`SELECT COUNT(*) AS n FROM "user"`);
  const unknown = await open(page, "x".repeat(43));
  expect(unknown.status()).toBe(401);
  expect((await unknown.json()).code).toBe("INVALID_ACTIVATION_LINK");
  expect(hasSessionCookie(unknown)).toBe(false);
  for (const data of [{ token: "x", extra: 1 }, {}, { token: 5 }, { token: "A".repeat(65) }]) {
    const response = await page.request.post("/api/auth/activation/redeem", { data });
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe("INVALID_INPUT");
  }
  expect(count(`SELECT COUNT(*) AS n FROM "user"`)).toBe(users);
});

test("rejects expired, used, revoked and suspended-account links with no session", async ({
  page,
}) => {
  await page.goto("/acceso");
  const expired = await seedPendingClient({ expiresInMs: -1000 });
  await expectRejected(page, expired.token, expired.userId);

  const used = await seedPendingClient();
  d1(`UPDATE invitations SET used_at = ${Date.now()} WHERE id = '${used.invitationId}'`);
  await expectRejected(page, used.token, used.userId);

  const revoked = await seedPendingClient();
  d1(`UPDATE invitations SET revoked_at = ${Date.now()} WHERE id = '${revoked.invitationId}'`);
  await expectRejected(page, revoked.token, revoked.userId);

  const banned = await seedPendingClient({ banned: true });
  await expectRejected(page, banned.token, banned.userId);
  expect(usedAt(banned.invitationId)).toBe(0);
});

test("opening a link starts an enrollment session tied to it, without spending it", async ({
  page,
}) => {
  const { userId, invitationId, token } = await seedPendingClient();
  await page.goto("/acceso");
  const response = await open(page, token);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ enrollment: true });
  const session = (await sessionOf(page)).session;
  expect(session.enrollment).toBe(true);
  expect(session.invitationId).toBe(invitationId);
  expect(usedAt(invitationId)).toBe(0);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='activation.redeem' AND target_user_id='${userId}'`,
    ),
  ).toBe(1);
  // Neither the token nor its hash is written to the audit log.
  expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE after_json LIKE '%${token}%'`)).toBe(0);

  // Opening it again replaces the earlier session.
  expect((await open(page, token)).status()).toBe(200);
  expect(sessionCount(userId)).toBe(1);
});

test("an activation session cannot reach anything but passkey registration", async ({ page }) => {
  const { token } = await seedPendingClient();
  await page.goto("/acceso");
  expect((await open(page, token)).status()).toBe(200);

  for (const path of ["/", "/conexion", "/posiciones", "/admin"]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect([response.status(), response.headers().location]).toEqual([303, "/recuperacion"]);
  }
  const refused = [
    await page.request.get("/api/auth/passkey/list-user-passkeys"),
    await page.request.post("/api/auth/passkey/delete-passkey", { data: { id: "x" } }),
    await page.request.post("/api/auth/revoke-sessions", { data: {} }),
    await page.request.post("/api/auth/update-user", { data: { name: "otro" } }),
    await page.request.get("/api/auth/admin/list-users"),
    await page.request.post("/api/auth/admin/create-user", {
      data: { email: "x@example.com", name: "x", role: "admin" },
    }),
    await page.request.post("/api/recovery-codes", { data: {} }),
  ];
  for (const response of refused) {
    expect(response.status()).toBe(403);
    expect((await response.json()).code).toBe("ENROLLMENT_ONLY");
  }
});

test("registering the first passkey spends the link, then ten codes are shown once", async ({
  context,
  page,
}) => {
  const { userId, invitationId, token } = await seedPendingClient();
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  expect((await open(page, token)).status()).toBe(200);

  const early = await page.request.post("/api/auth/enrollment/complete", { data: {} });
  expect(early.status()).toBe(403);
  expect((await early.json()).code).toBe("PASSKEY_REQUIRED");

  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  expect(usedAt(invitationId)).toBe(1);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='activation.complete' AND target_user_id='${userId}'`,
    ),
  ).toBe(1);

  const done = await page.request.post("/api/auth/enrollment/complete", { data: {} });
  expect(done.status()).toBe(200);
  expect(done.headers()["cache-control"]).toBe("no-store");
  expect((await done.json()).codes).toHaveLength(10);
  expect((await sessionOf(page)).session.enrollment).toBe(false);
  expect((await page.request.get("/operar", { maxRedirects: 0 })).status()).toBe(200);

  // Opening the spent link while signed in changes nothing: no new session, the client stays in.
  const late = await open(page, token);
  expect(late.status()).toBe(401);
  expect(sessionCount(userId)).toBe(1);
  expect((await sessionOf(page)).session.enrollment).toBe(false);

  // The spent link opens nothing, from this browser or any other.
  await context.clearCookies();
  const again = await open(page, token);
  expect(again.status()).toBe(401);
  expect(hasSessionCookie(again)).toBe(false);
});

test("a link revoked or expired after it was opened cannot register a passkey", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  for (const spoil of [
    (id: string) => `UPDATE invitations SET revoked_at = ${Date.now()} WHERE id = '${id}'`,
    (id: string) => `UPDATE invitations SET expires_at = 1 WHERE id = '${id}'`,
  ]) {
    const { userId, invitationId, token } = await seedPendingClient();
    expect((await open(page, token)).status()).toBe(200);
    d1(spoil(invitationId));
    const result = await registerPasskey(page, true);
    expect(result).toEqual({ status: 401, code: "INVALID_ACTIVATION_LINK" });
    expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId"='${userId}'`)).toBe(0);
    expect(usedAt(invitationId)).toBe(0);
  }
});

test("a passkey that fails user verification does not spend the link", async ({
  context,
  page,
}) => {
  const { userId, invitationId, token } = await seedPendingClient();
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, false);
  expect((await open(page, token)).status()).toBe(200);
  const result = await registerPasskey(page, false);
  expect(result.code).toBe("USER_VERIFICATION_REQUIRED");
  expect(usedAt(invitationId)).toBe(0);
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId"='${userId}'`)).toBe(0);
});

test("opening the link in another browser ends the earlier session", async ({ browser, page }) => {
  const { userId, token } = await seedPendingClient();
  await page.goto("/acceso");
  expect((await open(page, token)).status()).toBe(200);
  const other = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "cf-connecting-ip": "10.2.250.250", origin: origin },
  });
  await resendDroppedPosts(other);
  const otherPage = await other.newPage();
  expect((await open(otherPage, token)).status()).toBe(200);
  // D43: a read may still be served from the earlier browser's cached copy for 30 s, but
  // anything that changes state reads D1 and is refused at once.
  const stale = await page.request.post("/api/auth/enrollment/complete", { data: {} });
  expect(stale.status()).toBe(401);
  expect((await sessionOf(otherPage)).session.enrollment).toBe(true);
  expect(sessionCount(userId)).toBe(1);
  await other.close();
});

test("rate limits opening links per IP", async ({ page }) => {
  await page.goto("/acceso");
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    statuses.push((await open(page, randomUUID())).status());
  }
  expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
  expect(statuses.slice(5)).toEqual([429, 429]);
});

test("no public route creates a user", async ({ page }) => {
  await page.goto("/acceso");
  const users = count(`SELECT COUNT(*) AS n FROM "user"`);
  const attempts = [
    await page.request.post("/api/auth/sign-up/email", {
      data: { email: "x@example.com", password: "correct horse battery", name: "x" },
    }),
    await page.request.post("/api/auth/admin/create-user", {
      data: { email: "y@example.com", name: "y", role: "admin" },
    }),
    await page.request.post("/api/auth/activation/redeem", { data: { token: "z".repeat(43) } }),
  ];
  for (const response of attempts) expect(response.ok()).toBe(false);
  expect(count(`SELECT COUNT(*) AS n FROM "user"`)).toBe(users);
});
