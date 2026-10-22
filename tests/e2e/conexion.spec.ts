import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import {
  count,
  d1,
  registerPasskey,
  seedSignedInUser,
  virtualAuthenticator,
  origin,
} from "./support.ts";

// The engine's calls to TradeStation can't be intercepted from the browser, so a paste that would
// reach the token exchange is not sent here: the exchange with the pasted code, the accounts, the
// reused state and the revoke paths run against a mocked TradeStation in engine/test.
const SECRET = "e2e-secret-SHOULD-NEVER-APPEAR";

test.beforeEach(async ({ context }) => {
  const ip = `10.4.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: origin });
});

test("sends visitors without a session to the access screen", async ({ page }) => {
  await page.goto("/conexion");
  await expect(page).toHaveURL(/\/acceso$/);
  await page.goto("/conexion/callback?code=c&state=s");
  await expect(page).toHaveURL(/\/acceso$/);
});

const KEY = "e2e-client-id-0123456789";

/** Saves a key like a form submit and returns the authorize URL the page offers (paste mode). */
async function beginPasteConnection(page: Page) {
  const response = await page.request.post("/conexion?/connect", {
    form: { clientId: KEY, clientSecret: SECRET },
    // Like a form submit; without this SvelteKit answers a fetch with JSON.
    headers: { accept: "text/html" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).not.toContain(SECRET);
  const href = /href="(https:\/\/signin\.tradestation\.com\/authorize[^"]*)"/.exec(html)?.[1];
  return new URL((href ?? "").replaceAll("&amp;", "&"));
}

test("asks TradeStation to redirect to localhost without leaking the secret", async ({
  context,
  page,
}) => {
  const userId = await seedSignedInUser(context);
  await page.goto("/conexion");
  await expect(page.getByRole("heading", { name: "Conexión" })).toBeVisible();
  // Paste mode shows no callback URL to register and no paste step before a key is saved.
  await expect(page.locator("code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Completar conexión" })).toHaveCount(0);

  const authorizeUrl = await beginPasteConnection(page);
  expect(authorizeUrl.pathname).toBe("/authorize");
  expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
    response_type: "code",
    client_id: KEY,
    audience: "https://api.tradestation.com",
    redirect_uri: "http://localhost:3000",
    scope: "openid offline_access MarketData ReadAccount Trade",
  });
  expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  expect(authorizeUrl.toString()).not.toContain(SECRET);
  expect(count(`SELECT COUNT(*) AS n FROM broker_connection WHERE user_id='${userId}'`)).toBe(0);

  const html = await (await page.request.get("/conexion")).text();
  expect(html).not.toContain(SECRET);
});

test("shows the paste step after saving a key", async ({ context, page }) => {
  await seedSignedInUser(context);
  await page.goto("/conexion");
  await page.getByLabel("API key (client ID)").fill(KEY);
  await page.getByLabel("Secreto").fill(SECRET);
  // The new tab would reach the real TradeStation; the test only needs the page to react.
  await page.context().route("https://signin.tradestation.com/**", (route) => route.abort());
  await page.getByRole("button", { name: /Conectar con TradeStation/ }).click();
  await expect(page.getByRole("button", { name: "Completar conexión" })).toBeVisible();
  await expect(page.getByText("La página siguiente no va a cargar")).toBeVisible();
  await expect(page.getByLabel("Dirección copiada")).toBeVisible();
  await expect(page.getByLabel("Secreto")).toHaveValue("");
  if (process.env.E2E_SCREENSHOT_DIR) {
    for (const [name, width, height] of [
      ["desktop", 1440, 900],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: `${process.env.E2E_SCREENSHOT_DIR}/conexion-paste-${name}.png`,
        fullPage: true,
      });
    }
  }
});

test("rejects a pasted address that is foreign, malformed, declined or without a valid state", async ({
  context,
  page,
}) => {
  const userId = await seedSignedInUser(context);
  const authorizeUrl = await beginPasteConnection(page);
  const code = "pasted-code-SHOULD-NEVER-APPEAR";
  const rejected: [string, string][] = [
    [`http://localhost:3000/?code=${code}&state=${"a".repeat(64)}`, "El enlace de autorización"],
    [`http://localhost:3000/?code=${code}`, "El enlace de autorización"],
    [`http://localhost:3000/?state=${authorizeUrl.searchParams.get("state")}`, "No reconocemos"],
    [`http://localhost:3001/?code=${code}&state=s`, "No reconocemos"],
    [`${origin}/conexion/callback?code=${code}&state=s`, "No reconocemos"],
    [`http://localhost:3000/?code=${code}&state=s&extra=1`, "No reconocemos"],
    [`not an address ${code}`, "No reconocemos"],
    ["http://localhost:3000/?error=access_denied&error_description=nope", "No autorizaste"],
  ];
  for (const [pasted, message] of rejected) {
    const response = await page.request.post("/conexion?/paste", {
      form: { redirect: pasted },
      headers: { accept: "text/html" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(400);
    const html = await response.text();
    expect(html).toContain(message);
    // Nothing the client pasted comes back.
    expect(html).not.toContain(code);
    expect(html).not.toContain("localhost:3001");
  }
  expect(count(`SELECT COUNT(*) AS n FROM broker_connection WHERE user_id='${userId}'`)).toBe(0);
});

test("needs a session to paste", async ({ page }) => {
  const response = await page.request.post("/conexion?/paste", {
    form: { redirect: "http://localhost:3000/?code=c&state=s" },
    headers: { accept: "text/html" },
    maxRedirects: 0,
  });
  expect(response.status()).not.toBe(200);
  expect(await response.text()).not.toContain("Completar conexión");
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
  expect(response.status()).toBe(200);
});
