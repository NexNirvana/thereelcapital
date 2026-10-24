import { expect, test } from "./test.ts";
import { type Page } from "@playwright/test";
import { SETTLE_MS, seedTradingClient } from "./support.ts";
import { openPosition, sell, step } from "./trading.ts";

// The engine runs the local simulation with its clock pinned inside a regular session
// (tests/e2e/engine.env). Every scripted symbol asks US$101, so SIZE US$20,000 buys 198 shares:
// MSFT fills at once, SLOW is acknowledged and fills 8 s later, HOLD buys at once and its exits stay
// working until canceled. Positions only come from a filled
// entry, so each test buys first and then manages the position the engine opened.
// Set SCREENSHOT_DIR to also write desktop and mobile screenshots of each state.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

test.beforeEach(async ({ context, baseURL }) => {
  const ip = `10.9.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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

test("shows the position, its seven steps and sells the step's quantity", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openPosition(page, "MSFT", "198 acciones");
  await expect(page.getByRole("heading", { name: "MSFT" })).toBeVisible();
  await expect(page.getByText("198 iniciales · 0 vendidos")).toBeVisible();
  await expect(page.getByText("1 de 2 posiciones")).toBeVisible();
  await expect(page.getByText("Sin segunda posición")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Paso \d,/ })).toHaveCount(7);
  // The browser has nothing to type a quantity or a price into.
  await expect(page.locator("input:not([type=hidden]), textarea")).toHaveCount(0);
  await shoot(page, "position");

  // 30% of 198 is 59.4: the engine sells 59.
  await sell(page, step(page, 1));
  await expect(page.getByText("139 acciones restantes", { exact: true })).toBeVisible({
    timeout: SETTLE_MS,
  });
  await expect(page.getByText("198 iniciales · 59 vendidos")).toBeVisible();
  await expect(step(page, 1)).toBeDisabled();
  await expect(step(page, 1)).toHaveAccessibleName("Paso 1, 30%, vendido");
  await expect(page.getByText("29% vendido")).toBeVisible();
  await shoot(page, "after-step");
});

test("marks a step that rounds to zero and sends nothing for it", async ({ context, page }) => {
  // SIZE US$202 buys 2 shares: 30% sells 1, and the 20% step lands on the same target.
  await seedTradingClient(context, { sizeUsd: 202 });
  await openPosition(page, "MSFT", "2 acciones");
  await sell(page, step(page, 1));
  await expect(page.getByText("1 acción restante", { exact: true })).toBeVisible({
    timeout: SETTLE_MS,
  });

  await sell(page, step(page, 2));
  await expect(page.getByText("Paso 2 (20%): 0 acciones por redondeo")).toBeVisible({
    timeout: SETTLE_MS,
  });
  await expect(step(page, 2)).toBeDisabled();
  await expect(page.getByText("1 acción restante", { exact: true })).toBeVisible();
  await expect(page.getByText("Sin órdenes pendientes.")).toBeVisible();
  await shoot(page, "rounded-to-zero");

  // Only the entry and the first step were ever sent.
  await page.goto("/historial");
  await expect(page.getByRole("cell", { name: "Salida" })).toHaveCount(1);
});

test("sends one order when a step is double-clicked", async ({ context, page }) => {
  await seedTradingClient(context);
  await openPosition(page, "MSFT", "198 acciones");
  let posts = 0;
  await page.route("**/posiciones?/salir*", async (route) => {
    posts += 1;
    await route.continue();
  });
  await step(page, 1).dblclick();
  // The form disables itself on the first click, so the second one is not a second post.
  await expect(page.getByText("139 acciones restantes", { exact: true })).toBeVisible({
    timeout: SETTLE_MS,
  });
  expect(posts).toBe(1);
  await page.goto("/historial");
  await expect(page.getByRole("cell", { name: "Salida" })).toHaveCount(1);
});

test("closes the position with ALL OUT only after a confirmation", async ({ context, page }) => {
  await seedTradingClient(context);
  await openPosition(page, "MSFT", "198 acciones");
  await expect(page.getByText("ALL OUT · Cierra las 198 acciones restantes")).toBeVisible();

  // The mobile design says «Posición» and the short caption.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Posición", exact: true })).toBeVisible();
  await expect(page.getByText("ALL OUT · 198 acciones", { exact: true })).toBeVisible();
  await expect(page.getByText("ALL OUT · Cierra las 198 acciones restantes")).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "Cerrar posición" }).click();
  await expect(page.getByText("¿Cerrar la posición?")).toBeVisible();
  await shoot(page, "confirm-all-out");
  // Backing out sends nothing.
  await page.getByRole("button", { name: "Volver" }).click();
  await expect(page.getByText("¿Cerrar la posición?")).toHaveCount(0);
  await expect(page.getByText("198 acciones restantes", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Cerrar posición" }).click();
  await sell(page, page.getByRole("button", { name: "Confirmar cierre" }));
  await expect(page.getByText("No tienes posiciones abiertas.")).toBeVisible({
    timeout: SETTLE_MS,
  });
});

test("cancels a working exit and gives the step back", async ({ context, page }) => {
  await seedTradingClient(context);
  await openPosition(page, "HOLD", "198 acciones");
  await sell(page, step(page, 1));
  const pending = page.getByRole("region", { name: "Órdenes pendientes" });
  await expect(pending).toContainText("Recibida", { timeout: SETTLE_MS });
  await expect(step(page, 1)).toBeDisabled();
  await shoot(page, "pending-order");

  await pending.getByRole("button", { name: "Cancelar" }).click();
  await expect(pending).toContainText("Sin órdenes pendientes.", { timeout: SETTLE_MS });
  await expect(step(page, 1)).toBeEnabled({ timeout: SETTLE_MS });
  await expect(page.getByText("198 acciones restantes", { exact: true })).toBeVisible({
    timeout: SETTLE_MS,
  });
});

test("says «Activo» only for a stop the engine verified", async ({ context, page }) => {
  await seedTradingClient(context, {
    accounts: ["SIM-1"],
    positions: [
      { id: "pos-verified", symbol: "AAA", qty: 10, protectionState: "verified" },
      { id: "pos-unverified", symbol: "BBB", qty: 10, protectionState: "unverified" },
    ],
  });
  await page.goto("/posiciones?p=pos-unverified");
  const protection = page.getByRole("region", { name: "Protección y cierre" });
  await expect(protection).toContainText("Sin verificar");
  await expect(protection).not.toContainText("Activo");
  await expect(protection.getByRole("button", { name: "Activar" })).toBeDisabled();
  await expect(protection.getByRole("combobox")).toBeDisabled();
  await shoot(page, "unverified");

  await page.goto("/posiciones?p=pos-verified");
  await expect(protection).toContainText("Activo");
  await page.getByRole("link", { name: "BBB" }).click();
  await expect(protection).not.toContainText("Activo");
});

test("activates trailing once enough is sold, and the engine then holds it", async ({
  context,
  page,
}) => {
  await seedTradingClient(context, {
    accounts: ["SIM-1"],
    positions: [
      {
        id: "pos-trail",
        symbol: "MSFT",
        qty: 10,
        soldQty: 7,
        protectionState: "verified",
        steps: ["done", "done", "done", "done", "available", "available", "available"],
      },
    ],
  });
  await page.goto("/posiciones", { waitUntil: "networkidle" });
  const protection = page.getByRole("region", { name: "Protección y cierre" });
  await expect(protection).toContainText("Disponible desde 70% vendido");
  const activate = protection.getByRole("button", { name: "Activar" });
  await expect(activate).toBeEnabled();
  await shoot(page, "trailing-available");

  const answered = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/trailing"),
    { timeout: SETTLE_MS },
  );
  await activate.click();
  await answered;
  await expect(protection).toContainText("Trailing / 10%", { timeout: SETTLE_MS });
  await expect(protection.getByRole("button", { name: "Activar" })).toHaveCount(0);
  await shoot(page, "trailing-active");
});

test("keeps Activar disabled before the unlock share is sold", async ({ context, page }) => {
  await seedTradingClient(context, {
    accounts: ["SIM-1"],
    positions: [
      { id: "pos-early", symbol: "MSFT", qty: 10, soldQty: 3, protectionState: "verified" },
    ],
  });
  await page.goto("/posiciones");
  const protection = page.getByRole("region", { name: "Protección y cierre" });
  await expect(protection.getByRole("button", { name: "Activar" })).toBeDisabled();
  await expect(protection.getByRole("combobox")).toBeDisabled();
});

test("shows an option with the underlying apart from the contract", async ({ context, page }) => {
  await seedTradingClient(context, {
    positions: [
      {
        id: "pos-spy",
        symbol: "SPY 261120C600",
        qty: 50,
        soldQty: 35,
        protectionState: "verified",
        option: { underlying: "SPY", expiry: "2026-11-20", strike: 600_000_000, right: "call" },
        steps: ["done", "done", "done_zero", "done", "available", "available", "available"],
      },
    ],
  });
  await page.goto("/posiciones");
  await expect(page.getByRole("heading", { name: "SPY" })).toBeVisible();
  await expect(page.getByText("Call 600 · 20 nov 2026")).toBeVisible();
  await expect(page.getByRole("link", { name: "SPY · Call 600" })).toBeVisible();
  await expect(page.getByText("15 contratos restantes", { exact: true })).toBeVisible();
  await expect(page.getByText("50 iniciales · 35 vendidos")).toBeVisible();
  await expect(page.getByText("70% vendido", { exact: true })).toBeVisible();
  await expect(page.getByText("Porcentajes sobre los 50 contratos iniciales")).toBeVisible();
  await expect(page.getByText("ALL OUT · Cierra los 15 contratos restantes")).toBeVisible();
  const done = page.getByRole("button", { name: /vendido$/ });
  await expect(page.getByText("Paso 3 (10%): 0 contratos por redondeo")).toBeVisible();
  await expect(done).toHaveCount(3);
  await expect(done.first()).toBeDisabled();
  await expect(step(page, 5)).toBeEnabled();
  await shoot(page, "option");
});

test("switches between two positions", async ({ context, page }) => {
  await seedTradingClient(context, {
    positions: [
      { id: "pos-a", symbol: "AAA", qty: 10 },
      { id: "pos-b", symbol: "BBB", qty: 20, soldQty: 5 },
    ],
  });
  await page.goto("/posiciones");
  await expect(page.getByRole("heading", { name: "AAA" })).toBeVisible();
  await expect(page.getByText("2 de 2 posiciones")).toBeVisible();
  await expect(page.getByText("Sin segunda posición")).toHaveCount(0);
  await page.getByRole("link", { name: "BBB" }).click();
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  await expect(page.getByText("15 acciones restantes", { exact: true })).toBeVisible();
  // An unknown id falls back to the first open position.
  await page.goto("/posiciones?p=nope");
  await expect(page.getByRole("heading", { name: "AAA" })).toBeVisible();
});

test("selects a position from the loaded data, without asking the engine again", async ({
  context,
  page,
}) => {
  await seedTradingClient(context, {
    positions: [
      { id: "pos-a", symbol: "AAA", qty: 10 },
      { id: "pos-b", symbol: "BBB", qty: 20, soldQty: 5 },
    ],
  });
  // Count only the loads a selection causes: the 3 s poller never starts.
  await page.addInitScript(() => {
    const setIntervalOriginal = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
      ms === 3_000 ? 0 : setIntervalOriginal(handler, ms, ...args)) as typeof window.setInterval;
  });
  await page.goto("/posiciones", { waitUntil: "networkidle" });
  const loads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("__data.json")) loads.push(request.url());
  });
  const link = page.getByRole("link", { name: "BBB" });
  await link.hover();
  await page.waitForTimeout(500);
  expect(loads, "hover preload").toEqual([]);
  await link.click();
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  await expect(page.getByText("15 acciones restantes", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/posiciones\?p=pos-b$/);
  await expect(page.getByRole("link", { name: "BBB" })).toHaveAttribute("aria-current", "page");
  expect(loads).toEqual([]);
  await shoot(page, "selected-second");

  // A reload or a shared link keeps the choice, and the form actions still carry it.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  await page.getByRole("link", { name: "AAA" }).click();
  await expect(page.getByRole("heading", { name: "AAA" })).toBeVisible();
  await expect(page).toHaveURL(/p=pos-a$/);
  // Selecting replaces the history entry: back leaves the page instead of stepping through picks.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/posiciones/);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "AAA" })).toBeVisible();
  // The shell's own link loads the first position again, even though the page is reused.
  await page.getByRole("link", { name: "BBB" }).click();
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  await page.getByRole("link", { name: "Posiciones", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "AAA" })).toBeVisible();
});

test("keeps a picked position when the 3 s poll reloads the page", async ({ context, page }) => {
  await seedTradingClient(context, {
    positions: [
      { id: "pos-a", symbol: "AAA", qty: 10 },
      { id: "pos-b", symbol: "BBB", qty: 20 },
    ],
  });
  await page.goto("/posiciones?p=pos-a", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "BBB" }).click();
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  // Wait for a poll that starts after the click, then give the page a moment to apply it.
  await page.waitForResponse(
    (response) =>
      response.url().includes("__data.json") && response.url().includes("x-sveltekit-invalidated"),
    { timeout: 8_000 },
  );
  await page.waitForTimeout(500);
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  await expect(page).toHaveURL(/p=pos-b$/);
});

test("keeps a clicked position after acting on it", async ({ context, page }) => {
  await seedTradingClient(context, {
    positions: [
      { id: "pos-a", symbol: "AAA", qty: 10 },
      { id: "pos-b", symbol: "BBB", qty: 20 },
    ],
  });
  await page.goto("/posiciones", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "BBB" }).click();
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  await sell(page, step(page, 1));
  // The simulation does not know BBB, so the order is refused; the view stays on the pick.
  await expect(page.getByRole("alert")).toBeVisible({ timeout: SETTLE_MS });
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  await expect(page).toHaveURL(/p=pos-b/);
});

test("keeps the selected position after acting on it", async ({ context, page }) => {
  await seedTradingClient(context, {
    positions: [
      { id: "pos-a", symbol: "AAA", qty: 10 },
      { id: "pos-b", symbol: "BBB", qty: 20 },
    ],
  });
  await page.goto("/posiciones?p=pos-b", { waitUntil: "networkidle" });
  await sell(page, step(page, 1));
  // The simulation does not know BBB, so the order is refused; either way the view stays on BBB.
  await expect(page.getByRole("alert")).toBeVisible({ timeout: SETTLE_MS });
  await expect(page.getByRole("heading", { name: "BBB" })).toBeVisible();
  await expect(page).toHaveURL(/p=pos-b/);
});

test("wraps the seven steps 4 + 3 on a narrow screen", async ({ context, page }) => {
  await seedTradingClient(context, {
    positions: [{ id: "pos-a", symbol: "AAA", qty: 10 }],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/posiciones");
  const tops = await page
    .getByRole("button", { name: /^Paso \d,/ })
    .evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
  expect(tops).toHaveLength(7);
  expect(new Set(tops.slice(0, 4)).size).toBe(1);
  expect(new Set(tops.slice(4)).size).toBe(1);
  expect(tops[4]).toBeGreaterThan(tops[0] ?? 0);
});

test("ignores quantity and price the browser adds and rejects a bad step", async ({
  baseURL,
  context,
  page,
}) => {
  await seedTradingClient(context, {
    positions: [{ id: "pos-a", symbol: "AAA", qty: 10 }],
  });
  const send = (form: Record<string, string>) =>
    page.request.post("/posiciones?/salir", {
      form,
      headers: { origin: baseURL ?? "", accept: "application/json" },
    });
  const bad = await send({ positionId: "pos-a", step: "9" });
  expect(await bad.text()).toContain("Los datos enviados no son válidos.");
  // The engine would sell its own quantity, whatever the request says; here AAA is unknown to the
  // simulation, so the order is refused, never sent with 999.
  const tampered = await send({ positionId: "pos-a", step: "0", qty: "999", price: "1" });
  expect(await tampered.text()).not.toContain("999");
});

test("rejects a trailing percentage outside the allowed set and ignores extra fields", async ({
  baseURL,
  context,
  page,
}) => {
  await seedTradingClient(context, {
    positions: [{ id: "pos-a", symbol: "AAA", qty: 10, soldQty: 7 }],
  });
  const send = (form: Record<string, string>) =>
    page.request.post("/posiciones?/trailing", {
      form,
      headers: { origin: baseURL ?? "", accept: "application/json" },
    });
  const bad = await send({ positionId: "pos-a", trailingPct: "12" });
  expect(await bad.text()).toContain("Los datos enviados no son válidos.");
  const missing = await send({ trailingPct: "10" });
  expect(await missing.text()).toContain("Los datos enviados no son válidos.");
  // Extra fields change nothing: AAA is unknown to the simulation, so the engine has no bid and
  // refuses; no level is ever taken from the request.
  const tampered = await send({ positionId: "pos-a", trailingPct: "10", peak: "1", level: "1" });
  expect(await tampered.text()).not.toContain("Trailing activado");
});

test("needs a signed-in client", async ({ page }) => {
  const response = await page.goto("/posiciones");
  expect(response?.url()).toContain("/acceso");
});
