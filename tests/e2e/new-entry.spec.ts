import { expect, test } from "@playwright/test";
import { d1, seedSignedInUser, seedTradingClient } from "./support.ts";

// The engine runs the local simulation with its clock pinned inside a regular session
// (tests/e2e/engine.env): MSFT has an ask of US$101, so SIZE US$20,000 buys 198 shares.
// Set SCREENSHOT_DIR to also write desktop and mobile screenshots of each state.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

test.beforeEach(async ({ context }) => {
  const ip = `10.7.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: "http://localhost:8790" });
});

async function shoot(page: import("@playwright/test").Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  for (const [width, height, label] of [
    [1440, 900, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}-${label}.png`, fullPage: true });
  }
}

test("shows the quantity the server computed, in read-only rows", async ({ context, page }) => {
  await seedTradingClient(context, page);
  await page.goto("/operar");
  await expect(page.getByRole("heading", { name: "Nueva entrada" })).toBeVisible();
  await expect(page.getByText("0/2 posiciones · 0/3 entradas hoy")).toBeVisible();
  await expect(page.getByRole("button", { name: /Revisar orden/ })).toBeDisabled();

  await page.getByLabel("Símbolo").fill("msft");
  await page.getByRole("button", { name: "Consultar" }).click();
  await expect(page).toHaveURL(/simbolo=msft/i);
  const rows = page.locator(".form dl");
  await expect(rows).toContainText("US$20,000");
  await expect(rows).toContainText("US$101.00");
  await expect(rows).toContainText("198 acciones");
  await expect(rows).toContainText("Market");
  await expect(page.locator(".summary")).toContainText("198 acciones");
  await expect(page.locator(".summary")).toContainText("30%");
  await shoot(page, "acciones-preview");

  // With a preview, Revisar orden leads to the review step (order-review.spec.ts).
  await expect(page.getByRole("link", { name: /Revisar orden/ })).toHaveAttribute(
    "href",
    "/operar/revisar?tipo=acciones&cuenta=SIM-1&simbolo=MSFT",
  );
});

test("has no editable price, SIZE or quantity field", async ({ context, page }) => {
  await seedTradingClient(context, page, { accounts: ["SIM-1", "SIM-2"] });
  for (const url of ["/operar?simbolo=MSFT", "/operar?tipo=opciones"]) {
    await page.goto(url);
    const names = await page
      .locator("form input, form select, form textarea")
      .evaluateAll((els) => els.map((el) => el.getAttribute("name")));
    expect(names.every((name) => ["tipo", "cuenta", "simbolo"].includes(name ?? ""))).toBe(true);
    await expect(page.locator("input[type=number], input[inputmode=decimal]")).toHaveCount(0);
  }
});

test("rejects size, quantity and price sent by the browser", async ({ context, page }) => {
  await seedTradingClient(context, page);
  for (const extra of ["size=1", "qty=5", "cantidad=5", "precio=1", "price=1", "sizeUsd=1"]) {
    const response = await page.goto(`/operar?simbolo=MSFT&${extra}`);
    expect(response?.status()).toBe(400);
  }
  const ok = await page.goto("/operar?simbolo=MSFT");
  expect(ok?.status()).toBe(200);
  await expect(page.locator(".form dl")).toContainText("198 acciones");
});

test("sizes from the SIZE the admin set, not from the page", async ({ context, page }) => {
  await seedTradingClient(context, page, { sizeUsd: 10_000 });
  await page.goto("/operar?simbolo=MSFT");
  await expect(page.locator(".form dl")).toContainText("US$10,000");
  await expect(page.locator(".form dl")).toContainText("99 acciones");
});

test("drops the preview as soon as the symbol or the account changes", async ({
  context,
  page,
}) => {
  await seedTradingClient(context, page, { accounts: ["SIM-1", "SIM-2"] });
  await page.goto("/operar?simbolo=MSFT");
  await expect(page.locator(".form dl")).toContainText("198 acciones");

  await page.getByLabel("Símbolo").fill("AAPL");
  await expect(page.locator(".form dl")).not.toContainText("198 acciones");
  await expect(page.locator(".summary")).not.toContainText("MSFT");
  await page.getByLabel("Símbolo").fill("MSFT");
  await expect(page.locator(".form dl")).toContainText("198 acciones");

  await page.getByLabel("Cuenta").selectOption("SIM-2");
  await expect(page.locator(".form dl")).not.toContainText("198 acciones");
  await page.getByRole("button", { name: "Consultar" }).click();
  await expect(page.locator(".form dl")).toContainText("198 acciones");

  // Another tab starts clean too.
  await page.getByRole("link", { name: "Opciones" }).click();
  await expect(page).toHaveURL(/tipo=opciones/);
  await expect(page.locator(".summary")).not.toContainText("MSFT");
});

test("names the reason when the engine blocks the entry", async ({ context, page }) => {
  await seedTradingClient(context, page);
  await page.goto("/operar?simbolo=NOPE");
  await expect(page.getByText("No encontramos ese símbolo en TradeStation.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Revisar orden/ })).toBeDisabled();
  await shoot(page, "acciones-bloqueada");
});

test("blocks entries while the connection is unusable or not made", async ({ context, page }) => {
  const userId = await seedTradingClient(context, page);
  d1(`UPDATE broker_connection SET status = 'EXPIRED' WHERE user_id = '${userId}'`);
  await page.goto("/operar?simbolo=MSFT");
  await expect(page.getByText("La conexión con TradeStation no está disponible.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Revisar orden/ })).toBeDisabled();

  await seedSignedInUser(context);
  await page.goto("/operar");
  await expect(page.getByText("Conecta tu cuenta de TradeStation para operar.")).toBeVisible();
});

test("shows the option entry point without the chain", async ({ context, page }) => {
  await seedTradingClient(context, page);
  await page.goto("/operar?tipo=opciones");
  await expect(page.getByRole("link", { name: "Opciones" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: /Elegir contrato/ })).toHaveAttribute(
    "href",
    "/operar/cadena?cuenta=SIM-1",
  );
  await expect(page.getByLabel("Símbolo")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Revisar orden/ })).toBeDisabled();
  await shoot(page, "opciones");
});

test("says so when the connection has no account to trade", async ({ context, page }) => {
  await seedTradingClient(context, page, { accounts: [] });
  await page.goto("/operar?simbolo=MSFT");
  await expect(page.getByText("No hay una cuenta de TradeStation habilitada")).toBeVisible();
  await expect(page.getByRole("button", { name: /Revisar orden/ })).toBeDisabled();
});
