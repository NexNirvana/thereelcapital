import { expect, test } from "@playwright/test";
import { RECOVERY_CODE_COUNT } from "../../src/lib/domain/config.ts";
import { d1, seedSignedInUser, origin } from "./support.ts";

// Set SCREENSHOT_DIR to also write desktop and mobile screenshots of each state.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;
const viewports = [
  [1440, 900, "desktop"],
  [390, 844, "mobile"],
] as const;

test.beforeEach(async ({ context }) => {
  const ip = `10.6.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: origin });
});

function seedCodes(userId: string, count: number) {
  for (let n = 0; n < count; n++) {
    d1(
      `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('${userId}-${n}', '${userId}', '${userId}-h${n}')`,
    );
  }
}

async function snapshot(page: import("@playwright/test").Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  for (const [width, height, label] of viewports) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}-${label}.png` });
  }
}

test("lists only built screens, shows the market clock and no invented account", async ({
  context,
  page,
}) => {
  seedCodes(await seedSignedInUser(context), 8);
  await page.goto("/operar");
  const nav = page.getByRole("navigation", { name: "Principal" }).first();
  await expect(nav.getByRole("link", { name: "Operar" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Conexión" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Posiciones" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Historial" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await expect(page.getByText(/^\d\d:\d\d ET$/)).toBeVisible();
  await expect(page.locator("header.topbar .account")).toHaveCount(0);
  await expect(page.getByText("Aún no tienes códigos de recuperación")).toHaveCount(0);
  await snapshot(page, "shell-not-connected");
});

test("shows the connected state in the shell", async ({ context, page }) => {
  const userId = await seedSignedInUser(context);
  seedCodes(userId, 8);
  d1(
    `INSERT INTO broker_connection (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
     VALUES ('${userId}', 'e2e-client', 'x', 'x', 'k', NULL, 'CONNECTED', 0)`,
  );
  await page.goto("/operar");
  await expect(page.locator("header.topbar")).toContainText("TradeStation conectado");
  await snapshot(page, "shell-connected");
});

test("an admin reaches /admin from the shell", async ({ context, page }) => {
  seedCodes(await seedSignedInUser(context, { role: "admin" }), 8);
  await page.goto("/operar");
  await page
    .getByRole("navigation", { name: "Principal" })
    .first()
    .getByRole("link", { name: "Admin" })
    .click();
  await expect(page).toHaveURL("/admin");
});

test("shows a Spanish error page for an unknown address", async ({ context, page }) => {
  seedCodes(await seedSignedInUser(context), 8);
  const response = await page.goto("/operar/no-existe");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "No encontrada" })).toBeVisible();
  await expect(page.getByText("No encontramos esta página.")).toBeVisible();
  await expect(page.getByText("NOT_FOUND")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ir a Operar" })).toBeVisible();
  await snapshot(page, "error-404");
});

test("a client with no recovery codes generates them once from the shell", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context);
  await page.goto("/operar");
  await expect(page.getByText("Aún no tienes códigos de recuperación")).toBeVisible();
  await snapshot(page, "recovery-prompt");
  await page.getByRole("button", { name: "Generar códigos" }).click();
  await expect(
    page.getByRole("list", { name: "Códigos de recuperación" }).getByRole("listitem"),
  ).toHaveCount(RECOVERY_CODE_COUNT);
  await snapshot(page, "recovery-codes");
  await page.getByRole("button", { name: "Ya los guardé" }).click();
  await expect(page.getByText("Aún no tienes códigos de recuperación")).toHaveCount(0);
  await expect(page.getByText("Guarda tus códigos")).toHaveCount(0);
});

test("a stale session is asked to confirm with the passkey before generating codes", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context, { sessionAgeMs: 11 * 60 * 1000 });
  await page.goto("/operar");
  await page.getByRole("button", { name: "Generar códigos" }).click();
  await expect(page.getByRole("button", { name: "Confirmar con passkey" })).toBeVisible();
});

test("signing out from the shell returns to the access screen", async ({ context, page }) => {
  seedCodes(await seedSignedInUser(context), 8);
  await page.goto("/operar");
  await page.getByRole("button", { name: "Cerrar sesión" }).first().click();
  await expect(page).toHaveURL(/\/acceso$/);
  const response = await page.request.post("/api/recovery-codes");
  expect(response.status()).toBe(401);
});

test("signing out from the admin header returns to the access screen", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context, { role: "admin" });
  await page.goto("/admin");
  const header = page.getByRole("banner");
  await expect(header.getByText("SIM")).toBeVisible();
  await snapshot(page, "admin-header");
  await header.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/acceso$/);
});
