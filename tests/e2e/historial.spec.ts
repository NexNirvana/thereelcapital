import { expect, test } from "@playwright/test";
import { ENGINE_NOW, seedSignedInUser, seedTradingClient, origin } from "./support.ts";

// Orders are seeded straight into the client's Durable Object (there is no order UI yet): the
// screen only ever reads what the engine's `history` returns. Set SCREENSHOT_DIR for screenshots.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;
const DAY = 86_400_000;

const orders = [
  {
    id: "o1",
    symbol: "MSFT",
    state: "FILLED",
    qty: 198,
    filledQty: 198,
    avgFillPrice: 101_250_000,
    createdAt: ENGINE_NOW - 1000,
  },
  { id: "o2", symbol: "AAPL", state: "REJECTED", qty: 50, createdAt: ENGINE_NOW - 2000 },
  {
    id: "o3",
    symbol: "MSFT",
    state: "PARTIAL",
    qty: 100,
    filledQty: 40,
    avgFillPrice: 99_000_000,
    account: "SIM-2",
    createdAt: ENGINE_NOW - 3000,
  },
  { id: "o4", symbol: "NVDA", state: "CANCELED", qty: 10, createdAt: ENGINE_NOW - 9 * DAY },
  {
    id: "o5",
    symbol: "SPY",
    state: "UNKNOWN",
    qty: 20,
    kind: "exit",
    createdAt: ENGINE_NOW - 10 * DAY,
  },
] as const;

test.beforeEach(async ({ context }) => {
  const ip = `10.8.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: origin });
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

test("lists orders with state, quantities, fill price and New York time", async ({
  context,
  page,
}) => {
  await seedTradingClient(context, { accounts: ["SIM-1", "SIM-2"], orders });
  await page.goto("/historial");
  await expect(page.getByRole("heading", { name: "Historial", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Historial" }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );

  const table = page.getByRole("table", { name: /Órdenes/ });
  await expect(table.getByRole("row")).toHaveCount(orders.length + 1);
  const filled = table.getByRole("row").filter({ hasText: "198/198" });
  await expect(filled).toContainText("MSFT");
  await expect(filled).toContainText("Ejecutada");
  await expect(filled).toContainText("US$101.25");
  await expect(filled).toContainText("4 nov 2026, 9:59 ET");
  await expect(table).toContainText("Rechazada");
  await expect(table).toContainText("Parcial");
  await expect(table).toContainText("No verificada");
  await expect(page.getByRole("table", { name: /Eventos/ })).toContainText(
    "TradeStation conectado",
  );
  await shoot(page, "lista");
});

test("filters by account, symbol and date", async ({ context, page }) => {
  await seedTradingClient(context, { accounts: ["SIM-1", "SIM-2"], orders });
  // Typing before the page hydrates is lost when it takes over the form.
  await page.goto("/historial", { waitUntil: "networkidle" });
  const table = page.getByRole("table", { name: /Órdenes/ });

  await page.getByLabel("Símbolo").fill("msft");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page).toHaveURL(/simbolo=msft/i);
  await expect(table.getByRole("row")).toHaveCount(3);

  await page.getByLabel("Cuenta").selectOption("SIM-2");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("Parcial");
  await shoot(page, "filtrado");

  await page.getByRole("link", { name: "Quitar filtros" }).click();
  await page.getByLabel("Hasta").fill("2026-10-30");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table).toContainText("NVDA");
  await expect(table).not.toContainText("MSFT");
});

test("shows an empty state and says when filters match nothing", async ({ context, page }) => {
  await seedTradingClient(context);
  await page.goto("/historial");
  await expect(
    page.getByText("Aún no tienes órdenes. Cuando operes, aparecerán aquí."),
  ).toBeVisible();
  await shoot(page, "vacio");
  await page.goto("/historial?simbolo=ZZZ");
  await expect(page.getByText("No hay órdenes con estos filtros.")).toBeVisible();
});

test("shows no P&L, balance or account value", async ({ context, page }) => {
  await seedTradingClient(context, { orders });
  await page.goto("/historial");
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/P\s?&\s?L|ganancia|pérdida|saldo|balance|equity|poder de compra/i);
});

test("rejects unknown parameters, REAL and a malformed cursor", async ({ context, page }) => {
  await seedTradingClient(context);
  for (const query of ["clientId=x", "modo=REAL", "desde=ayer", "despues=%27%3B--"]) {
    const response = await page.goto(`/historial?${query}`);
    expect(response?.status(), query).toBe(400);
  }
});

test("pages through older orders with a cursor", async ({ context, page }) => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `m${String(i).padStart(2, "0")}`,
    symbol: "MSFT",
    state: "FILLED",
    qty: 1,
    filledQty: 1,
    avgFillPrice: 100_000_000,
    createdAt: ENGINE_NOW - i * 1000,
  }));
  await seedTradingClient(context, { orders: many });
  await page.goto("/historial");
  const table = page.getByRole("table", { name: /Órdenes/ });
  await expect(table.getByRole("row")).toHaveCount(26);
  await page.getByRole("link", { name: /Ver órdenes anteriores/ }).click();
  await expect(page).toHaveURL(/despues=/);
  await expect(table.getByRole("row")).toHaveCount(6);
  await expect(page.getByRole("link", { name: /Ver órdenes anteriores/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Eventos" })).toHaveCount(0);
});

test("keeps the history after signing out and in again", async ({ context, page }) => {
  const userId = await seedTradingClient(context, { orders });
  await page.goto("/historial");
  await expect(page.getByRole("table", { name: /Órdenes/ }).getByRole("row")).toHaveCount(6);

  await page
    .getByRole("button", { name: /Cerrar sesión/ })
    .first()
    .click();
  await expect(page).toHaveURL(/acceso/);
  await page.goto("/historial");
  await expect(page).toHaveURL(/acceso/);

  await context.clearCookies();
  await seedSignedInUser(context, { existingUserId: userId });
  await page.goto("/historial");
  await expect(page.getByRole("table", { name: /Órdenes/ }).getByRole("row")).toHaveCount(6);
  await expect(page.getByRole("table", { name: /Órdenes/ })).toContainText("US$101.25");
});

test("another client never sees these orders", async ({ context, page }) => {
  await seedTradingClient(context, { orders });
  await context.clearCookies();
  await seedTradingClient(context);
  await page.goto("/historial");
  await expect(page.getByRole("table", { name: /Órdenes/ })).toHaveCount(0);
  await expect(page.getByText("Aún no tienes órdenes")).toBeVisible();
});
