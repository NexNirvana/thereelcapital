import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
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

test.beforeEach(async ({ context }) => {
  const ip = `10.1.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
});

test("recovers access through the screen: code, new passkey, new codes, trading page", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  const authenticator = await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  const code = newRecoveryCode();
  const hash = await hashToken("recovery-code", normalizeRecoveryCode(code), authSecret);
  d1(
    `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('${randomUUID()}','${userId}','${hash}')`,
  );
  await authenticator.forgetCredentials();
  await context.clearCookies();

  await page.goto("/acceso");
  await page.getByRole("link", { name: "Usar código de recuperación" }).click();
  await expect(page).toHaveURL(/\/recuperacion$/);

  await page.getByLabel("Código de recuperación").fill(newRecoveryCode());
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("alert")).toContainText("El código no es válido");

  await page.getByLabel("Código de recuperación").fill(code);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { name: /nueva passkey/i })).toBeVisible();

  // Reloading mid-recovery resumes at the passkey step, and trading pages stay closed.
  await page.reload();
  await expect(page.getByRole("heading", { name: /nueva passkey/i })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/recuperacion$/);

  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("heading", { name: /Guarda tus/i })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Códigos de recuperación" }).getByRole("listitem"),
  ).toHaveCount(10);

  await page.getByRole("button", { name: "Ya los guardé" }).click();
  await expect(page).toHaveURL("/");
  expect((await (await page.request.get("/api/auth/get-session")).json()).session.enrollment).toBe(
    false,
  );
});

test("sends the client back to the code step when the enrollment session expires", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  const authenticator = await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  const code = newRecoveryCode();
  const hash = await hashToken("recovery-code", normalizeRecoveryCode(code), authSecret);
  d1(
    `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('${randomUUID()}','${userId}','${hash}')`,
  );
  await authenticator.forgetCredentials();
  await context.clearCookies();

  await page.goto("/recuperacion");
  await page.getByLabel("Código de recuperación").fill(code);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("button", { name: "Crear passkey" })).toBeVisible();
  d1(
    `UPDATE "session" SET "createdAt" = '${new Date(Date.now() - 20 * 60_000).toISOString()}' WHERE "userId" = '${userId}'`,
  );

  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("alert")).toContainText("Tu sesión de registro venció");
  await expect(page.getByLabel("Código de recuperación")).toBeVisible();
});

test("retrying after finishing fails does not register a second passkey", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  const authenticator = await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  const code = newRecoveryCode();
  const hash = await hashToken("recovery-code", normalizeRecoveryCode(code), authSecret);
  d1(
    `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('${randomUUID()}','${userId}','${hash}')`,
  );
  await authenticator.forgetCredentials();
  await context.clearCookies();

  await page.goto("/recuperacion");
  await page.getByLabel("Código de recuperación").fill(code);
  await page.getByRole("button", { name: "Continuar" }).click();

  let failNext = true;
  await page.route("**/api/auth/enrollment/complete", (route) => {
    if (!failNext) return route.continue();
    failNext = false;
    return route.fulfill({ status: 500, json: {} });
  });
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  // A second registration would be refused (the credential already exists); finishing is enough.
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("heading", { name: /Guarda tus/i })).toBeVisible();
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId" = '${userId}'`)).toBe(2);
});
