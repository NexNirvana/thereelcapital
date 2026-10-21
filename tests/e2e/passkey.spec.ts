import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Same throwaway value playwright.config.ts passes to the dev server; not a credential.
const authSecret = "e2e-only-secret-0123456789-0123456789";

// Test-only seeding straight into the local D1 the dev server uses. There is no sign-up or
// session-minting endpoint in the app, so a registered user needs a row and a signed cookie.
function d1(sql: string): unknown[] {
  const output = execFileSync(
    "node_modules/.bin/wrangler",
    ["d1", "execute", "DB", "--local", "--json", "--command", sql],
    { encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(output);
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  return first && Array.isArray(first.results) ? first.results : [];
}

function count(sql: string): number {
  const row = d1(sql)[0];
  return typeof row === "object" && row !== null && "n" in row && typeof row.n === "number"
    ? row.n
    : -1;
}

async function seedSignedInUser(context: BrowserContext) {
  const userId = randomUUID();
  const token = randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  d1(
    `INSERT INTO "user" ("id","name","email","emailVerified","role","createdAt","updatedAt")
     VALUES ('${userId}','Cliente','${userId}@example.com',0,'user','${now}','${now}');
     INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId")
     VALUES ('${randomUUID()}','${expires}','${token}','${now}','${now}','${userId}')`,
  );
  const signature = createHmac("sha256", authSecret).update(token).digest("base64");
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: encodeURIComponent(`${token}.${signature}`),
      url: "http://localhost:8790",
    },
  ]);
  return userId;
}

// An authenticator that cannot verify the user at all (no PIN or biometrics) is what produces
// UV=0 at registration: Chrome refuses to create a discoverable credential with a capable but
// unverified one.
async function virtualAuthenticator(context: BrowserContext, page: Page, userVerified: boolean) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: userVerified,
      isUserVerified: userVerified,
      automaticPresenceSimulation: true,
    },
  });
  return {
    setUserVerified: (isUserVerified: boolean) =>
      cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified }),
  };
}

// Registers a passkey for the signed-in session. `requestUv: false` rewrites the server's options
// to "discouraged" so an unverified authenticator really produces UV=0 and the server's own check,
// not the browser, is what has to reject it.
function registerPasskey(page: Page, requestUv: boolean) {
  return page.evaluate(async (requestUv) => {
    const options = await (await fetch("/api/auth/passkey/generate-register-options")).json();
    if (!requestUv) options.authenticatorSelection.userVerification = "discouraged";
    const credential = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
    });
    if (!(credential instanceof PublicKeyCredential)) throw new Error("no credential");
    const response = await fetch("/api/auth/passkey/verify-registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: credential.toJSON() }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, code: body?.code ?? null };
  }, requestUv);
}

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
