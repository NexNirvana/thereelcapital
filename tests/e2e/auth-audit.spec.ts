import { expect, test } from "@playwright/test";
import {
  count,
  d1,
  registerPasskey,
  seedPendingClient,
  seedSignedInUser,
  virtualAuthenticator,
} from "./support.ts";

const origin = "http://localhost:8790";

test.beforeEach(async ({ context }) => {
  const ip = `10.8.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
});

const audited = (action: string, userId: string) =>
  count(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = '${action}' AND target_user_id = '${userId}'`,
  );
const anonymousRows = (action: string) =>
  d1(`SELECT after_json FROM audit_log WHERE action = '${action}' AND actor_id = 'anonymous'`);

// Issue #104 item 4: sign-in, sign-out and rejected attempts leave a trail, without secrets.
test("audits a passkey sign-in and a sign-out", async ({ context, page }) => {
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  await context.clearCookies();
  expect(audited("auth.sign_in", userId)).toBe(0);

  await page.goto("/acceso");
  await page.getByRole("button", { name: "Entrar con passkey" }).click();
  await expect(page).toHaveURL(/\/operar$/);
  expect(audited("auth.sign_in", userId)).toBe(1);

  expect(audited("auth.sign_out", userId)).toBe(0);
  const out = await page.request.post("/api/auth/sign-out", { data: {}, headers: { origin } });
  expect(out.status()).toBe(200);
  expect(audited("auth.sign_out", userId)).toBe(1);
});

test("audits a rejected recovery code without storing it", async ({ page }) => {
  const code = "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ";
  const before = anonymousRows("recovery.redeem_failed").length;
  const response = await page.request.post("/api/auth/recovery/redeem", { data: { code } });
  expect(response.status()).toBe(401);
  const rows = anonymousRows("recovery.redeem_failed");
  expect(rows.length).toBe(before + 1);
  const row = JSON.stringify(rows.at(-1));
  expect(row).toContain("invalid_code");
  expect(row).not.toContain(code);
});

test("audits a rejected activation link without storing it", async ({ page }) => {
  const token = "y".repeat(43);
  const before = anonymousRows("activation.redeem_failed").length;
  const response = await page.request.post("/api/auth/activation/redeem", { data: { token } });
  expect(response.status()).toBe(401);
  const rows = anonymousRows("activation.redeem_failed");
  expect(rows.length).toBe(before + 1);
  const row = JSON.stringify(rows.at(-1));
  expect(row).toContain("invalid_link");
  expect(row).not.toContain(token);
});

test("writes activation.redeem once, for the session that started", async ({ page }) => {
  const client = await seedPendingClient();
  const response = await page.request.post("/api/auth/activation/redeem", {
    data: { token: client.token },
  });
  expect(response.status()).toBe(200);
  expect(audited("activation.redeem", client.userId)).toBe(1);
  expect(count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = '${client.userId}'`)).toBe(1);
});
