import { expect, test } from "@playwright/test";
import { count, d1, registerPasskey, seedSignedInUser, virtualAuthenticator } from "./support.ts";

// The engine's calls to TradeStation can't be intercepted from the browser; the token exchange,
// accounts and revoke paths are covered against a mocked TradeStation in engine/test.
const SECRET = "e2e-secret-SHOULD-NEVER-APPEAR";

test.beforeEach(async ({ context }) => {
  const ip = `10.4.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: "http://localhost:8790" });
});

test("sends visitors without a session to the access screen", async ({ page }) => {
  await page.goto("/conexion");
  await expect(page).toHaveURL(/\/acceso$/);
  await page.goto("/conexion/callback?code=c&state=s");
  await expect(page).toHaveURL(/\/acceso$/);
});

test("shows the callback URL and sends the client to TradeStation without leaking the secret", async ({
  context,
  page,
}) => {
  const userId = await seedSignedInUser(context);
  await page.goto("/conexion");
  await expect(page.getByRole("heading", { name: "Conexión" })).toBeVisible();
  await expect(page.locator("code")).toHaveText("http://localhost:8790/conexion/callback");

  // Posted without following the redirect, so the browser never reaches the real TradeStation.
  const response = await page.request.post("/conexion?/connect", {
    form: { clientId: "e2e-client-id-0123456789", clientSecret: SECRET },
    // Like a form submit; without this SvelteKit answers a fetch with JSON.
    headers: { accept: "text/html" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  const authorizeUrl = new URL(response.headers().location ?? "");
  expect(authorizeUrl.origin).toBe("https://signin.tradestation.com");
  expect(await response.text()).not.toContain(SECRET);

  expect(authorizeUrl.pathname).toBe("/authorize");
  expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "e2e-client-id-0123456789",
    audience: "https://api.tradestation.com",
    redirect_uri: "http://localhost:8790/conexion/callback",
    scope: "openid offline_access MarketData ReadAccount Trade",
  });
  expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  expect(authorizeUrl.toString()).not.toContain(SECRET);
  expect(count(`SELECT COUNT(*) AS n FROM broker_connection WHERE user_id='${userId}'`)).toBe(0);

  // Nothing about the secret comes back when the page is shown again.
  const html = await (await page.request.get("/conexion")).text();
  expect(html).not.toContain(SECRET);
});

test("rejects a foreign or missing state and a declined authorization with Spanish copy", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context);
  for (const query of ["code=abc&state=" + "a".repeat(64), "code=abc", "state=abc", ""]) {
    await page.goto(`/conexion/callback?${query}`);
    await expect(page).toHaveURL(/\/conexion\?error=STATE_INVALID$/);
    await expect(page.getByRole("alert")).toContainText("El enlace de autorización no es válido");
  }
  await page.goto("/conexion/callback?error=access_denied&error_description=nope");
  await expect(page).toHaveURL(/\/conexion\?error=AUTHORIZATION_DENIED$/);
  await expect(page.getByRole("alert")).toContainText("No autorizaste el acceso");
  // The code never leaves the callback URL: the redirect target carries no code or state.
  expect(page.url()).not.toContain("code=");
});

test("ignores an unknown error code in the address bar", async ({ context, page }) => {
  await seedSignedInUser(context);
  await page.goto("/conexion?error=<script>alert(1)</script>");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("asks for a fresh session before saving a key", async ({ context, page }) => {
  const userId = await seedSignedInUser(context);
  d1(
    `UPDATE "session" SET "createdAt" = '${new Date(Date.now() - 3_600_000).toISOString()}' WHERE "userId" = '${userId}'`,
  );
  await page.goto("/conexion");
  await page.getByLabel("API key (client ID)").fill("e2e-client-id-0123456789");
  await page.getByLabel("Secreto").fill(SECRET);
  await page.getByRole("button", { name: /Conectar con TradeStation/ }).click();
  await expect(page.getByRole("alert")).toContainText("Confirma tu identidad");
  await expect(page.getByLabel("Secreto")).toHaveValue("");
  expect(await page.content()).not.toContain(SECRET);
});

test("a passkey confirmation makes the session fresh again", async ({ context, page }) => {
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  const userId = await seedSignedInUser(context);
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  d1(
    `UPDATE "session" SET "createdAt" = '${new Date(Date.now() - 3_600_000).toISOString()}' WHERE "userId" = '${userId}'`,
  );

  await page.goto("/conexion");
  await page.getByLabel("API key (client ID)").fill("e2e-client-id-0123456789");
  await page.getByLabel("Secreto").fill(SECRET);
  await page.getByRole("button", { name: /Conectar con TradeStation/ }).click();
  await expect(page.getByRole("alert")).toContainText("Confirma tu identidad");

  await page.getByRole("button", { name: "Confirmar con passkey" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const response = await page.request.post("/conexion?/connect", {
    form: { clientId: "e2e-client-id-0123456789", clientSecret: SECRET },
    headers: { accept: "text/html" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
});
