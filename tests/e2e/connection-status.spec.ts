import { expect, test } from "@playwright/test";
import { d1, ENGINE_NOW, seedSignedInUser } from "./support.ts";

// The refresh itself talks to TradeStation from the engine and is covered against a mocked
// TradeStation in engine/test; here a stored connection state is shown in the top bar.
// Set SCREENSHOT_DIR to also write desktop and mobile screenshots of each state.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;
const HOUR = 3_600_000;

const states = [
  {
    name: "ok",
    status: "CONNECTED",
    expiresAt: "NULL",
    text: "TradeStation conectado",
    action: null,
  },
  {
    name: "expiring",
    status: "CONNECTED",
    expiresAt: () => `${ENGINE_NOW + HOUR}`,
    text: "TradeStation vence pronto",
    action: "Reconectar con TradeStation",
  },
  {
    name: "expired",
    status: "EXPIRED",
    expiresAt: "NULL",
    text: "TradeStation venció",
    action: "Reconectar con TradeStation",
  },
  {
    name: "revoked",
    status: "REVOKED",
    expiresAt: "NULL",
    text: "TradeStation sin acceso",
    action: "Reconectar con TradeStation",
  },
] as const;

test.beforeEach(async ({ context }) => {
  const ip = `10.5.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: "http://localhost:8790" });
});

for (const state of states) {
  test(`shows a ${state.name} connection in the top bar`, async ({ context, page }) => {
    const userId = await seedSignedInUser(context);
    const expiresAt = typeof state.expiresAt === "function" ? state.expiresAt() : state.expiresAt;
    d1(
      `INSERT INTO broker_connection (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
       VALUES ('${userId}', 'e2e-client', 'x', 'x', 'k', ${expiresAt}, '${state.status}', 0)`,
    );

    for (const [width, height, label] of [
      [1440, 900, "desktop"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/conexion");
      const topbar = page.locator("header.topbar");
      await expect(topbar).toContainText(state.text);
      const reconnect = topbar.getByRole("link", { name: "Reconectar con TradeStation" });
      await expect(reconnect).toHaveCount(state.action === null ? 0 : 1);
      if (state.action !== null) await expect(reconnect).toHaveAttribute("href", "/conexion");
      if (SCREENSHOT_DIR) {
        await page.screenshot({ path: `${SCREENSHOT_DIR}/conexion-${state.name}-${label}.png` });
      }
    }
  });
}

test("shows no connection as unconnected with a way to connect", async ({ context, page }) => {
  await seedSignedInUser(context);
  await page.goto("/conexion");
  const topbar = page.locator("header.topbar");
  await expect(topbar).toContainText("TradeStation sin conectar");
  await expect(topbar.getByRole("link", { name: "Conectar con TradeStation" })).toBeVisible();
});
