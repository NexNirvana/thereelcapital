import { type Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { d1, origin, seedTradingClient, SETTLE_MS } from "./support.ts";
import { send } from "./trading.ts";

// REAL mode from the client's side, against the local simulation only (tests/e2e/engine.env opens
// the deployment switch; REAL-1 is a simulated account, no TradeStation host is contacted). The
// client's own switch is set straight in D1: the admin screen that sets it has its own spec.
// Set SCREENSHOT_DIR to also write desktop and mobile screenshots of each state.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

test.beforeEach(async ({ context, baseURL }) => {
  const ip = `10.8.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: baseURL ?? "" });
});

async function shoot(page: Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  for (const [width, height, label] of [
    [1440, 900, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

// The simulated REAL-1 account can be bound to one client only (D52 lock 3), so each test frees it.
const enableReal = (userId: string, enabled = true) =>
  d1(
    `${enabled ? "DELETE FROM real_account_bindings;" : ""}
     UPDATE client_settings SET real_trading_enabled = ${enabled ? 1 : 0} WHERE user_id = '${userId}'`,
  );

const modeSwitch = (page: Page) => page.getByRole("form", { name: "Modo de operación" });
const realBand = (page: Page) => page.getByText(/Las órdenes que envíes se ejecutan/).first();

test("switches to REAL, trades on the simulated REAL account and switches back", async ({
  context,
  page,
}) => {
  const userId = await seedTradingClient(context);
  enableReal(userId);

  await page.goto("/operar", { waitUntil: "networkidle" });
  await expect(modeSwitch(page).getByRole("button", { name: "SIM" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(realBand(page)).toHaveCount(0);
  await shoot(page, "shell-sim-selector");

  await modeSwitch(page).getByRole("button", { name: "REAL" }).click();
  await expect(page).toHaveURL(/\/operar$/);
  await expect(modeSwitch(page).getByRole("button", { name: "REAL" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(realBand(page)).toBeVisible();
  await shoot(page, "shell-real");

  // The REAL account appears once the engine lists it (a sync pass), then the entry can be sent.
  await expect(async () => {
    await page.goto("/operar?simbolo=MSFT", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Enviar orden" })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: SETTLE_MS * 2 });
  await expect(page.getByText("REAL · dinero real", { exact: true })).toBeVisible();
  await expect(page.getByText(/dinero real\./)).toBeVisible();
  await expect(page.getByText("TradeStation · REAL-1")).toBeVisible();
  await shoot(page, "operar-review-real");
  await send(page);
  // The order status page also says REAL, never the SIM footer.
  await expect(page).toHaveURL(/\/operar\/revisar\//);
  await expect(page.getByText("REAL · Dinero real", { exact: true })).toHaveCount(2);
  await expect(page.getByText("SIM · Simulación, sin dinero real")).toHaveCount(0);

  await expect(async () => {
    await page.goto("/posiciones", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "MSFT" })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: SETTLE_MS * 2 });
  await shoot(page, "posiciones-real");
  await page.goto("/historial", { waitUntil: "networkidle" });
  await expect(page.getByRole("row", { name: /MSFT/ }).first()).toBeVisible();
  await shoot(page, "historial-real");
  await page.goto("/conexion", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Cuentas REAL" })).toBeVisible();
  await expect(page.getByText("REAL-1")).toBeVisible();
  await shoot(page, "conexion-real");

  // Back to SIM: the REAL position and order are not shown there.
  await modeSwitch(page).getByRole("button", { name: "SIM" }).click();
  await expect(realBand(page)).toHaveCount(0);
  await page.goto("/posiciones", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "MSFT" })).toHaveCount(0);
  await page.goto("/historial", { waitUntil: "networkidle" });
  await expect(page.getByRole("row", { name: /MSFT/ })).toHaveCount(0);
});

test("shows no selector and stays in SIM for a client without REAL", async ({ context, page }) => {
  await seedTradingClient(context);
  // A cookie asking for REAL is only a hint: the engine does not list it for this client.
  await context.addCookies([{ name: "reel_modo", value: "REAL", url: origin }]);
  await page.goto("/operar", { waitUntil: "networkidle" });
  await expect(modeSwitch(page)).toHaveCount(0);
  await expect(realBand(page)).toHaveCount(0);

  const refused = await page.request.post("/modo", {
    form: { modo: "REAL" },
    headers: { origin },
    maxRedirects: 0,
  });
  expect(refused.status()).toBe(303);
  expect(refused.headers()["set-cookie"] ?? "").not.toMatch(/reel_modo=REAL/);
});

test("refuses a form prepared in another mode and discards it", async ({ context, page }) => {
  const userId = await seedTradingClient(context);
  enableReal(userId);
  await page.goto("/operar", { waitUntil: "networkidle" });
  await modeSwitch(page).getByRole("button", { name: "REAL" }).click();
  await expect(realBand(page)).toBeVisible();

  // An order form from a tab that was still in SIM.
  const stale = await page.request.post("/operar?/enviar", {
    form: {
      modo: "SIM",
      tipo: "acciones",
      cuenta: "SIM-1",
      simbolo: "MSFT",
      intentId: "AAAAAAAAAAAAAAAAAAAAAA",
      cantidad: "198",
    },
    headers: { origin, accept: "application/json" },
  });
  expect(await stale.text()).toContain("Cambiaste de modo en otra pestaña");
});

test("keeps REAL selectable with entries disabled when only exits are allowed", async ({
  context,
  page,
}) => {
  const userId = await seedTradingClient(context);
  enableReal(userId);
  await page.goto("/operar", { waitUntil: "networkidle" });
  await modeSwitch(page).getByRole("button", { name: "REAL" }).click();
  await expect(realBand(page)).toBeVisible();
  // Something is open in REAL, then the admin turns the client's switch off.
  await expect(async () => {
    await page.goto("/operar?simbolo=MSFT", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Enviar orden" })).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: SETTLE_MS * 2 });
  await send(page);
  enableReal(userId, false);

  await page.goto("/operar?simbolo=MSFT", { waitUntil: "networkidle" });
  await expect(modeSwitch(page).getByRole("button", { name: "REAL" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText(/Solo salidas/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeDisabled();
  await shoot(page, "shell-real-exits-only");
});
