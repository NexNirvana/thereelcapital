import { expect, test } from "@playwright/test";
import { count, d1, registerPasskey, seedSignedInUser, virtualAuthenticator } from "./support.ts";
import type { BrowserContext, Page } from "@playwright/test";

async function currentUser(page: Page) {
  const response = await page.request.get("/api/auth/get-session");
  return response.json();
}

const sessionCount = (userId: string) =>
  count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = '${userId}'`);
const passkeyCount = (userId: string) =>
  count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId" = '${userId}'`);

// A user with one verified passkey whose browser holds no session, ready to sign in on /acceso.
async function userWithPasskey(context: BrowserContext, page: Page) {
  await page.goto("/acceso");
  const authenticator = await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  await context.clearCookies();
  return { authenticator, userId };
}

test("signs in with a user-verified passkey", async ({ context, page }) => {
  const { userId } = await userWithPasskey(context, page);
  expect(passkeyCount(userId)).toBe(1);

  await page.goto("/acceso");
  await page.getByRole("button", { name: "Entrar con passkey" }).click();

  await expect(page).toHaveURL("/");
  expect((await currentUser(page)).user.id).toBe(userId);
});

test("rejects registering a passkey without user verification", async ({ context, page }) => {
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, false);
  const userId = await seedSignedInUser(context);

  expect(await registerPasskey(page, false)).toEqual({
    status: 403,
    code: "USER_VERIFICATION_REQUIRED",
  });
  expect(passkeyCount(userId)).toBe(0);
});

test("rejects signing in without user verification and creates no session", async ({
  context,
  page,
}) => {
  const { authenticator, userId } = await userWithPasskey(context, page);
  const sessionsBefore = sessionCount(userId);
  await authenticator.setUserVerified(false);
  // Ask for "discouraged" so the authenticator answers with UV=0 instead of refusing itself.
  await page.route("**/api/auth/passkey/generate-authenticate-options", async (route) => {
    const response = await route.fetch();
    const options = await response.json();
    await route.fulfill({ response, json: { ...options, userVerification: "discouraged" } });
  });

  await page.goto("/acceso");
  await page.getByRole("button", { name: "Entrar con passkey" }).click();

  await expect(page.getByRole("alert")).toContainText("Tu passkey debe confirmar tu identidad");
  await expect(page).toHaveURL(/\/acceso$/);
  expect((await currentUser(page)) ?? null).toBeNull();
  expect(sessionCount(userId)).toBe(sessionsBefore);
});

test("shows a generic message when the authenticator itself cannot verify", async ({
  context,
  page,
}) => {
  const { authenticator, userId } = await userWithPasskey(context, page);
  const sessionsBefore = sessionCount(userId);
  await authenticator.setUserVerified(false);

  await page.goto("/acceso");
  await page.getByRole("button", { name: "Entrar con passkey" }).click();

  await expect(page.getByRole("alert")).toContainText("No pudimos iniciar sesión con tu passkey");
  expect((await currentUser(page)) ?? null).toBeNull();
  expect(sessionCount(userId)).toBe(sessionsBefore);
});

test("a banned user sees a clear message and gets no session", async ({ context, page }) => {
  const { userId } = await userWithPasskey(context, page);
  const sessionsBefore = sessionCount(userId);
  d1(`UPDATE "user" SET "banned" = 1 WHERE "id" = '${userId}'`);

  await page.goto("/acceso");
  await page.getByRole("button", { name: "Entrar con passkey" }).click();

  await expect(page.getByRole("alert")).toContainText("Tu acceso está suspendido");
  await expect(page).toHaveURL(/\/acceso$/);
  expect((await currentUser(page)) ?? null).toBeNull();
  expect(sessionCount(userId)).toBe(sessionsBefore);
});

test("offers passkey sign-in only: no email, password or sign-up", async ({ page }) => {
  await page.goto("/acceso");
  await expect(page.getByRole("button", { name: "Entrar con passkey" })).toBeVisible();
  await expect(page.getByText("Acceso solo por invitación")).toBeVisible();
  await expect(page.getByRole("link", { name: "Usar código de recuperación" })).toBeVisible();
  await expect(page.locator("input")).toHaveCount(0);
});
