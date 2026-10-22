import { expect, test } from "./test.ts";
import { type Page } from "@playwright/test";
import { SETTLE_MS, d1, seedTradingClient, origin } from "./support.ts";

// The engine runs the local simulation with its clock pinned inside a regular session
// (tests/e2e/engine.env). Every scripted symbol asks US$101, so SIZE US$20,000 buys 198 shares and
// the symbol picks the ending (engine/src/broker/local-sim/scenarios.ts): MSFT fills at once,
// SLOW is acknowledged and fills 8 s later, PART fills 50 and stays open, RJCT is acknowledged and
// then rejected, DROP loses the broker's answer (UNKNOWN until reconciled).
// Set SCREENSHOT_DIR to also write desktop and mobile screenshots of each state.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

test.beforeEach(async ({ context }) => {
  const ip = `10.8.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: origin });
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
}

async function openReview(page: Page, symbol: string) {
  await page.goto(`/operar?simbolo=${symbol}`);
  await page.getByRole("link", { name: /Revisar orden/ }).click();
  await expect(page).toHaveURL(/\/operar\/revisar\?/);
  await expect(page.getByRole("heading", { name: "Revisar orden" })).toBeVisible();
  // Let the page hydrate before submitting: a native post would reload it under the assertions.
  await page.waitForLoadState("networkidle");
}

/** Submits the review and waits until the browser is on the order's status page. */
async function send(page: Page, button = "Enviar orden") {
  await page.getByRole("button", { name: button }).click();
  await expect(page).toHaveURL(/\/operar\/revisar\/[A-Za-z0-9_-]{22}$/, { timeout: SETTLE_MS });
}

const SEND = "/operar/revisar?tipo=acciones&cuenta=SIM-1&simbolo=SLOW&/enviar";
const state = (page: Page) => page.getByRole("status");

test("reviews the order read-only, then follows it to filled", async ({ context, page }) => {
  await seedTradingClient(context);
  await openReview(page, "SLOW");
  const rows = page.locator("dl");
  await expect(rows).toContainText("TradeStation · SIM-1");
  await expect(rows).toContainText("SIM");
  await expect(rows).toContainText("Comprar para abrir");
  await expect(rows).toContainText("US$20,000");
  await expect(rows).toContainText("198 acciones");
  await expect(rows).toContainText("Market");
  await expect(page.locator("input:not([type=hidden]), select, textarea")).toHaveCount(0);
  await shoot(page, "review");

  await send(page);
  await expect(state(page)).toContainText("Recibida por TradeStation");
  // Acknowledged is not executed.
  await expect(page.getByText("Ejecutada")).toHaveCount(0);
  await shoot(page, "acknowledged");

  await expect(state(page)).toContainText("Ejecutada", { timeout: SETTLE_MS });
  await expect(state(page)).toContainText("198 de 198");
  await shoot(page, "filled");
});

test("shows a partial fill as partial, never as executed", async ({ context, page }) => {
  await seedTradingClient(context);
  await openReview(page, "PART");
  await send(page);
  await expect(state(page)).toContainText("Ejecución parcial", { timeout: SETTLE_MS });
  await expect(state(page)).toContainText("50 de 198");
  await expect(page.getByText("Ejecutada")).toHaveCount(0);
  await shoot(page, "partial");
});

test("shows a rejected order as rejected with nothing executed", async ({ context, page }) => {
  await seedTradingClient(context);
  await openReview(page, "RJCT");
  await send(page);
  await expect(state(page)).toContainText("Rechazada", { timeout: SETTLE_MS });
  await expect(state(page)).toContainText("No se ejecutó nada");
  await expect(page.getByText("Ejecutada")).toHaveCount(0);
  await shoot(page, "rejected");
});

test("explains a lost broker answer as being verified, not as a failure", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openReview(page, "DROP");
  await send(page);
  await expect(state(page)).toContainText("Verificando");
  await expect(state(page)).toContainText("no es un fallo");
  await expect(page.getByText("Rechazada")).toHaveCount(0);
  await expect(page.getByText("Ejecutada")).toHaveCount(0);
  await shoot(page, "unknown");
  // Reconciliation finds the order the broker did take.
  await expect(state(page)).toContainText("Ejecutada", { timeout: SETTLE_MS });
});

test("asks to re-confirm when the quantity changed, then sends the new one", async ({
  context,
  page,
}) => {
  const userId = await seedTradingClient(context);
  await openReview(page, "MSFT");
  await expect(page.locator("dl")).toContainText("198 acciones");

  // The admin halves SIZE while the client is reading.
  d1(`UPDATE client_settings SET size_usd = 10000 WHERE user_id = '${userId}'`);
  await page.getByRole("button", { name: "Enviar orden" }).click();
  await expect(page.getByText("La cantidad cambió")).toBeVisible({ timeout: SETTLE_MS });
  await expect(page).toHaveURL(/\/operar\/revisar\?/);
  await expect(page.getByText("Antes eran 198 acciones y ahora son 99 acciones.")).toBeVisible();
  await expect(page.locator("dl")).toContainText("99 acciones");
  await shoot(page, "reconfirm");

  // Nothing was sent: no entry counted yet.
  const other = await context.newPage();
  await other.goto("/operar?simbolo=MSFT");
  await expect(other.getByText("0/2 posiciones · 0/3 entradas hoy")).toBeVisible();
  await other.close();

  await send(page, "Confirmar y enviar");
  await expect(page.locator("dl")).toContainText("99");
});

test("sends one order when Enviar orden is double-clicked", async ({ context, page }) => {
  await seedTradingClient(context);
  await openReview(page, "MSFT");
  await page.getByRole("button", { name: /Enviar|Enviando/ }).dblclick();
  await expect(page).toHaveURL(/\/operar\/revisar\/[A-Za-z0-9_-]{22}$/, { timeout: SETTLE_MS });
  await page.goto("/operar?simbolo=MSFT");
  await expect(page.getByText(/[01]\/2 posiciones · 1\/3 entradas hoy/)).toBeVisible();
});

test("sends one order when the same intent is posted twice at once", async ({ context, page }) => {
  await seedTradingClient(context);
  await openReview(page, "SLOW");
  const intentId = await page.locator("input[name=intentId]").inputValue();
  const form = { tipo: "acciones", cuenta: "SIM-1", simbolo: "SLOW", intentId, cantidad: "198" };
  const post = () =>
    page.request.post(SEND, {
      form,
      headers: { origin: origin, accept: "text/html" },
      maxRedirects: 0,
    });
  const [first, second] = await Promise.all([post(), post()]);
  expect([first.status(), second.status()]).toEqual([303, 303]);
  expect(first.headers().location).toBe(second.headers().location);
  await page.goto("/operar?simbolo=SLOW");
  await expect(page.getByText(/[01]\/2 posiciones · 1\/3 entradas hoy/)).toBeVisible();
});

test("ignores size, price and other fields the browser adds", async ({ context, page }) => {
  await seedTradingClient(context);
  await openReview(page, "SLOW");
  const intentId = await page.locator("input[name=intentId]").inputValue();
  const send = (extra: Record<string, string>) =>
    page.request.post(SEND, {
      form: {
        tipo: "acciones",
        cuenta: "SIM-1",
        simbolo: "SLOW",
        intentId,
        cantidad: "198",
        ...extra,
      },
      headers: { origin: origin, accept: "text/html" },
      maxRedirects: 0,
    });

  // A different quantity is only compared, never used: the server asks to re-confirm.
  const wrongQty = await page.request.post(SEND, {
    form: { tipo: "acciones", cuenta: "SIM-1", simbolo: "SLOW", intentId, cantidad: "5" },
    headers: { origin: origin, accept: "text/html" },
  });
  expect(await wrongQty.text()).toContain("La cantidad cambió");

  const tampered = await send({ size: "1", sizeUsd: "1", qty: "5", precio: "1", price: "1" });
  expect(tampered.status()).toBe(303);
  await page.goto(tampered.headers().location ?? "/");
  await expect(page.locator("dl")).toContainText("198");
  await expect(page.locator("dl")).toContainText("Market");

  // The intent id of another symbol cannot be reused.
  const other = await page.request.post(SEND, {
    form: { tipo: "acciones", cuenta: "SIM-1", simbolo: "MSFT", intentId, cantidad: "198" },
    headers: { origin: origin, accept: "text/html" },
    maxRedirects: 0,
  });
  expect(other.status()).not.toBe(303);
});

test("sends nobody else's order to the status page", async ({ context, page }) => {
  await seedTradingClient(context);
  await page.goto("/operar/revisar/AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByText("Todavía no hay registro de esta orden.")).toBeVisible();
  const bad = await page.goto("/operar/revisar/not-an-id");
  expect(bad?.status()).toBe(404);
});

test("returns to Nueva entrada when the review has no instrument", async ({ context, page }) => {
  await seedTradingClient(context);
  await page.goto("/operar/revisar");
  await expect(page).toHaveURL(/\/operar$/);
});
