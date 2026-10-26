import { expect, test } from "./test.ts";
import { type Page } from "@playwright/test";
import { seedTradingClient, origin } from "./support.ts";

// The engine runs the local simulation (tests/e2e/engine.env). Its dev MSFT chain has two
// Friday expirations with 395, 400 and 405 calls and puts; the 405 put is listed with no market.
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

async function openChain(page: Page) {
  await page.goto("/operar/cadena");
  await page.getByRole("textbox", { name: "Subyacente" }).fill("msft");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page).toHaveURL(/subyacente=msft/i);
  await page.getByLabel("Vencimientos").getByRole("link").first().click();
  await expect(page.getByRole("table")).toBeVisible();
}

test("picks a CALL from the chain and returns to /operar with the exact option symbol", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await page.goto("/operar?tipo=opciones");
  await page.getByRole("link", { name: /Elegir contrato/ }).click();
  await expect(page).toHaveURL(/\/operar\/cadena/);
  await expect(page.getByRole("heading", { name: "Cadena de opciones" })).toBeVisible();

  await openChain(page);
  await expect(page.getByText("Datos de las 10:00:00")).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("400");
  await expect(rows.nth(1)).toContainText("7.00 / 7.10");
  await shoot(page, "cadena");

  await page.getByRole("link", { name: /^Elegir Call 400/ }).click();
  await expect(page).toHaveURL(/\/operar\?.*tipo=opciones/);
  const symbol = new URL(page.url()).searchParams.get("simbolo") ?? "";
  expect(symbol).toMatch(/^MSFT \d{6}C400$/);

  // The underlying and the contract are shown apart, never as one name.
  const summary = page.locator(".summary");
  await expect(summary.locator(".instrument")).toHaveText("MSFT");
  await expect(summary.locator(".contract-name")).toHaveText(
    new RegExp(`^Call 400 · \\d{1,2} \\S+ 20${symbol.slice(5, 7)}$`),
  );
  await expect(summary).toContainText("Subyacente");
  await expect(summary.getByText(symbol, { exact: true })).toBeVisible();
  await expect(page.locator(".form")).toContainText(`Símbolo del contrato: ${symbol}`);
  await expect(page.locator(".form dl")).toContainText("US$7.10");
  await expect(page.locator(".form dl")).toContainText("28 contratos");
  await shoot(page, "operar-contrato");

  // Back to the chain keeps the way out.
  await page.getByRole("link", { name: /Cambiar contrato/ }).click();
  await expect(page).toHaveURL(/\/operar\/cadena/);
});

test("shows a side without a market as missing and does not offer it", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openChain(page);
  const last = page.locator("tbody tr").nth(2);
  await expect(last).toContainText("405");
  await expect(last.getByText("Sin dato")).toHaveCount(1);
  await expect(last).not.toContainText("0.00");
  await expect(last.getByRole("link")).toHaveCount(1);
  await expect(page.getByRole("link", { name: /^Elegir Put 405/ })).toHaveCount(0);
  await shoot(page, "cadena-sin-dato");
});

test("calls the snapshot out of date as it ages and refreshes on demand", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  // The live poll would keep the snapshot fresh; failing it leaves the screen's own ageing.
  await page.route(/\/operar\/cadena\/cotizaciones\?/, (route) => route.abort());
  await page.clock.install();
  await openChain(page);
  const freshness = page.locator(".freshness");
  await expect(freshness).toContainText("hace 0 s");
  await expect(freshness).not.toContainText("desactualizados");

  await page.clock.fastForward(45_000);
  await expect(freshness).toContainText("desactualizados");
  await shoot(page, "cadena-desactualizada");

  await page.getByRole("button", { name: "Actualizar" }).click();
  await expect(freshness).toContainText("hace 0 s");
  await expect(freshness).not.toContainText("desactualizados");
});

test("refuses unknown parameters and underlyings without options", async ({ context, page }) => {
  await seedTradingClient(context);
  const response = await page.goto("/operar/cadena?subyacente=MSFT&precio=1");
  expect(response?.status()).toBe(400);
  await page.goto("/operar/cadena?subyacente=ZZZZ");
  await expect(page.getByRole("alert")).toContainText("No encontramos eso en TradeStation.");
  await page.goto("/operar/cadena?subyacente=%3Cscript%3E");
  await expect(page.getByRole("alert")).toContainText("Escribe el ticker");
});

test("does not describe an equity as a contract", async ({ context, page }) => {
  await seedTradingClient(context);
  await page.goto("/operar?tipo=opciones&simbolo=MSFT");
  await expect(page.locator(".summary .contract-name")).toHaveCount(0);
});

const setVisibility = (page: Page, value: "hidden" | "visible") =>
  page.evaluate((visibility) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);

test("keeps the bid and ask live without reloading, and stops while the tab is hidden", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  // The simulated quotes never move, so the poll's answer is rewritten: what matters is that the
  // open screen shows what the endpoint last said, with no navigation.
  let polls = 0;
  await page.route(/\/operar\/cadena\/cotizaciones\?/, async (route) => {
    polls += 1;
    const response = await route.fetch();
    const body = await response.json();
    for (const row of body.chain.strikes) {
      if (row.strike === 400_000_000) row.call = { ...row.call, bid: 7_250_000, ask: 7_350_000 };
    }
    await route.fulfill({ response, json: body });
  });
  await openChain(page);
  await expect(page.locator("tbody tr").nth(1)).toContainText("7.25 / 7.35", { timeout: 8_000 });
  await expect(page.getByText("se actualizan solos")).toBeVisible();
  await shoot(page, "cadena-viva");

  await setVisibility(page, "hidden");
  const hiddenFrom = polls;
  await page.waitForTimeout(5_000);
  expect(polls).toBe(hiddenFrom);
  await setVisibility(page, "visible");
  await expect.poll(() => polls, { timeout: 8_000 }).toBeGreaterThan(hiddenFrom);
});

test("the live chain endpoint needs a session, rejects extra inputs and never lacks a side as 0", async ({
  context,
  page,
  request,
}) => {
  const href = "/operar/cadena/cotizaciones?subyacente=MSFT&vencimiento=";
  expect((await request.get(`${href}2026-11-06`)).status()).toBe(401);

  await seedTradingClient(context);
  await page.goto("/operar/cadena?subyacente=MSFT");
  const first = await page
    .getByLabel("Vencimientos")
    .getByRole("link")
    .first()
    .getAttribute("href");
  const expiration = new URL(first ?? "", origin).searchParams.get("vencimiento") ?? "";
  const ok = await page.request.get(`${href}${expiration}`);
  expect(ok.status()).toBe(200);
  expect(ok.headers()["cache-control"]).toBe("no-store");
  const body = await ok.json();
  expect(body.status).toBe("ready");
  expect(body.chain.strikes).toHaveLength(3);
  expect(body.chain.strikes[2].put).toBeNull();

  for (const extra of ["simbolo=MSFT", "precio=1", "qty=5"]) {
    expect((await page.request.get(`${href}${expiration}&${extra}`)).status()).toBe(400);
  }
  expect((await page.request.get(`${href}ayer`)).status()).toBe(400);
});
