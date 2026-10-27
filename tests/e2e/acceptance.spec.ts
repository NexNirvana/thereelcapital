import { expect, test } from "./test.ts";
import { type APIResponse, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  SETTLE_MS,
  d1,
  origin,
  resendDroppedPosts,
  seedSignedInUser,
  seedTradingClient,
} from "./support.ts";
import { openPosition, openEntry, sell, step } from "./trading.ts";

// The browser side of docs/test-plan.md "Broker SIM acceptance" steps 4 to 10, on the local
// simulation (tests/e2e/engine.env, scripted symbols in engine/src/broker/local-sim/scenarios.ts).
// Every scripted symbol asks US$101, so SIZE US$20,000 buys 198 shares and US$25,000 buys 247.

const DAILY_LIMIT_MESSAGE = "Ya usaste las entradas de hoy.";
const POSITION_LIMIT_MESSAGE = "Ya tienes el máximo de posiciones abiertas.";

test.beforeEach(async ({ context }) => {
  const ip = `10.6.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin });
});

/** Posts the open entry's form the way the browser does, without following the redirect. */
async function postEntry(
  page: Page,
  symbol: string,
  quantity: number,
  intentId: string,
): Promise<APIResponse> {
  return page.request.post(`/operar?tipo=acciones&cuenta=SIM-1&simbolo=${symbol}&/enviar`, {
    form: { tipo: "acciones", cuenta: "SIM-1", simbolo: symbol, intentId, cantidad: `${quantity}` },
    headers: { origin, accept: "text/html" },
    maxRedirects: 0,
  });
}

async function secondTab(context: BrowserContext, symbol: string) {
  const tab = await context.newPage();
  await openEntry(tab, symbol);
  // Read now: once the limits close, the page drops the form and its intent id, but the id of the
  // moment it was prepared is still what a late post would carry.
  const intentId = await tab.locator("input[name=intentId]").inputValue();
  return { tab, intentId };
}

test.describe("daily entry limit (step 6)", () => {
  test("rejects a fourth entry on the same day, shows 3/3 and still lets the position exit", async ({
    context,
    page,
  }) => {
    await seedTradingClient(context, { entriesToday: 2 });
    // Both entries are prepared while the day still has a free entry.
    await openEntry(page, "MSFT");
    const { tab: late, intentId: lateId } = await secondTab(context, "HOLD");

    await page.getByRole("button", { name: "Enviar orden" }).click();
    await expect(page).toHaveURL(/\/operar\/revisar\/[A-Za-z0-9_-]{22}$/, { timeout: SETTLE_MS });

    const rejected = await postEntry(late, "HOLD", 198, lateId);
    expect(rejected.status()).toBe(409);
    expect(await rejected.text()).toContain(DAILY_LIMIT_MESSAGE);

    await late.goto("/operar?simbolo=HOLD");
    await expect(late.getByText("1/2 posiciones · 3/3 entradas hoy")).toBeVisible({
      timeout: SETTLE_MS,
    });
    await expect(late.getByText(DAILY_LIMIT_MESSAGE)).toBeVisible();
    await expect(late.getByRole("button", { name: "Enviar orden" })).toBeDisabled();

    // Limits block entries, never exits.
    await late.goto("/posiciones", { waitUntil: "networkidle" });
    await expect(late.getByText("198 acciones restantes", { exact: true })).toBeVisible({
      timeout: SETTLE_MS,
    });
    await sell(late, step(late, 1));
    await expect(late.getByText("198 acciones restantes", { exact: true })).toHaveCount(0, {
      timeout: SETTLE_MS,
    });
  });

  test("disables the button with the reason after a refused send from the page", async ({
    context,
    page,
  }) => {
    await seedTradingClient(context, { entriesToday: 2 });
    await openEntry(page, "MSFT");
    const { tab: late } = await secondTab(context, "HOLD");
    // The late page keeps the preview it opened with: the live price is not what refuses it.
    await late.route("**/operar/cotizacion*", (route) => route.abort());
    await page.getByRole("button", { name: "Enviar orden" }).click();
    await expect(page).toHaveURL(/\/operar\/revisar\/[A-Za-z0-9_-]{22}$/, { timeout: SETTLE_MS });

    await late.getByRole("button", { name: "Enviar orden" }).click();
    await expect(late.getByRole("alert")).toContainText(DAILY_LIMIT_MESSAGE, {
      timeout: SETTLE_MS,
    });
    await expect(late.getByRole("button", { name: "Enviar orden" })).toBeDisabled({
      timeout: SETTLE_MS,
    });
    await expect(late.locator("#review-reason")).toContainText(DAILY_LIMIT_MESSAGE);
  });

  test("lets only one of two simultaneous entries take the last daily slot", async ({
    context,
    page,
  }) => {
    await seedTradingClient(context, { entriesToday: 2 });
    await openEntry(page, "MSFT");
    const pageId = await page.locator("input[name=intentId]").inputValue();
    const { tab: other, intentId: otherId } = await secondTab(context, "HOLD");

    const [first, second] = await Promise.all([
      postEntry(page, "MSFT", 198, pageId),
      postEntry(other, "HOLD", 198, otherId),
    ]);
    expect([first.status(), second.status()].sort()).toEqual([303, 409]);
    const loser = first.status() === 409 ? first : second;
    expect(await loser.text()).toContain(DAILY_LIMIT_MESSAGE);

    await other.goto("/operar?simbolo=MSFT");
    await expect(other.getByText(/[01]\/2 posiciones · 3\/3 entradas hoy/)).toBeVisible({
      timeout: SETTLE_MS,
    });
  });
});

test.describe("open position limit (step 8)", () => {
  test("rejects a third open position with the stable message", async ({ context, page }) => {
    await seedTradingClient(context);
    // Prepared while a slot is free, so the send itself is what the engine refuses.
    const { tab: stale, intentId: staleId } = await secondTab(context, "SLOW");
    await openPosition(page, "MSFT", "198 acciones");
    await openPosition(page, "HOLD", "198 acciones");

    await page.goto("/operar?simbolo=PART");
    await expect(page.getByText("2/2 posiciones · 2/3 entradas hoy")).toBeVisible({
      timeout: SETTLE_MS,
    });
    await expect(page.getByText(POSITION_LIMIT_MESSAGE)).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar orden" })).toBeDisabled();

    // The slots were taken after this page was prepared: post it anyway.
    const rejected = await postEntry(stale, "SLOW", 198, staleId);
    expect(rejected.status()).toBe(409);
    expect(await rejected.text()).toContain(POSITION_LIMIT_MESSAGE);
  });

  test("keeps trailing off until the unlock share is sold, then lets it be activated", async ({
    context,
    page,
  }) => {
    await seedTradingClient(context);
    await openPosition(page, "MSFT", "198 acciones");
    const protection = page.getByRole("region", { name: "Protección y cierre" });
    const activate = protection.getByRole("button", { name: "Activar" });
    await expect(activate).toBeDisabled();

    // Steps 1 to 3 add up to less than the 70% unlock; the fourth reaches it.
    for (const n of [1, 2, 3]) {
      await sell(page, step(page, n));
      await expect(step(page, n)).toHaveAccessibleName(/vendido$/, { timeout: SETTLE_MS });
      await expect(activate).toBeDisabled();
    }
    await sell(page, step(page, 4));
    await expect(step(page, 4)).toHaveAccessibleName(/vendido$/, { timeout: SETTLE_MS });
    await expect(activate).toBeEnabled({ timeout: SETTLE_MS });
  });
});

async function otherSession(browser: Browser) {
  const context = await browser.newContext();
  await resendDroppedPosts(context);
  const ip = `10.6.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin });
  return context;
}

test("uses the SIZE the admin raised only for the next entry (step 5)", async ({
  browser,
  context,
  page,
}) => {
  const clientId = await seedTradingClient(context);
  await openPosition(page, "MSFT", "198 acciones");

  const bystanderContext = await otherSession(browser);
  const bystander = await bystanderContext.newPage();
  await seedTradingClient(bystanderContext);

  const adminContext = await otherSession(browser);
  await seedSignedInUser(adminContext, { role: "admin" });
  const admin = await adminContext.newPage();
  await admin.goto(`/admin/clientes/${clientId}`, { waitUntil: "networkidle" });
  await admin.getByLabel("SIZE por entrada (USD)").fill("25000");
  await admin.getByRole("button", { name: "Guardar configuración" }).click();
  await expect(admin.getByText("Configuración guardada.")).toBeVisible({ timeout: SETTLE_MS });
  await adminContext.close();

  // The next entry is sized from the new SIZE.
  await openEntry(page, "HOLD");
  await expect(page.locator(".form dl")).toContainText("US$25,000");
  await expect(page.locator(".form dl")).toContainText("247 acciones");

  // The order that already filled keeps its quantity.
  await page.goto("/posiciones", { waitUntil: "networkidle" });
  await expect(page.getByText("198 acciones restantes", { exact: true })).toBeVisible({
    timeout: SETTLE_MS,
  });

  // Another client is still sized from their own SIZE.
  await openEntry(bystander, "MSFT");
  await expect(bystander.locator(".form dl")).toContainText("US$20,000");
  await expect(bystander.locator(".form dl")).toContainText("198 acciones");
  await bystanderContext.close();
});

// Not automatable here: the local simulation keeps its access token valid, so a revoked refresh
// token never turns the protection into «Sin verificar» (the engine tests cover that pass), and
// reconnecting needs TradeStation's OAuth. The row is changed the way the engine's refresh and a
// finished reconnect would write it.
test("blocks entries while the token is revoked and allows them once reconnected (step 10)", async ({
  context,
  page,
}) => {
  const clientId = await seedTradingClient(context);
  d1(`UPDATE broker_connection SET status = 'REVOKED' WHERE user_id = '${clientId}'`);
  await page.goto("/operar?simbolo=HOLD");
  await expect(
    page.getByText("La conexión con TradeStation no está disponible. Reconéctala para operar."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeDisabled();

  d1(`UPDATE broker_connection SET status = 'CONNECTED' WHERE user_id = '${clientId}'`);
  await page.goto("/operar?simbolo=HOLD");
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeVisible({
    timeout: SETTLE_MS,
  });
});
