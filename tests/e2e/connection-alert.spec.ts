import { expect, test } from "./test.ts";
import { d1, origin, seedSignedInUser, seedTradingClient } from "./support.ts";

// Set SCREENSHOT_DIR to also write desktop and mobile screenshots.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

test.beforeEach(async ({ context }) => {
  const ip = `10.6.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: origin });
});

const LOST = "La conexión con TradeStation no está activa";

test("shows an alert on every screen while the connection is lost, and drops it once reconnected", async ({
  context,
  page,
}) => {
  const userId = await seedTradingClient(context, {
    status: "REVOKED",
    positions: [
      {
        id: "p-alert",
        symbol: "AAPL",
        qty: 476,
        soldQty: 0,
      },
    ],
  });

  for (const [width, height, label] of [
    [1440, 900, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/posiciones");
    const alert = page.getByRole("alert").filter({ hasText: LOST });
    await expect(alert).toContainText("TradeStation rechazó o cerró la conexión.");
    await expect(alert).toContainText("No podemos verificar tus posiciones, precios ni órdenes");
    await expect(alert.getByRole("link", { name: "Reconectar con TradeStation" })).toHaveAttribute(
      "href",
      "/conexion",
    );
    await expect(page.getByText(/Datos sin verificar/)).toBeVisible();
    if (SCREENSHOT_DIR) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/alert-posiciones-${label}.png` });
    }

    await page.goto("/operar");
    await expect(page.getByRole("alert").filter({ hasText: LOST })).toBeVisible();
    await expect(page.getByText(/entradas hoy\s*· Datos sin verificar/)).toBeVisible();
    if (SCREENSHOT_DIR) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/alert-operar-${label}.png` });
    }

    // /conexion already explains it next to the reconnect form.
    await page.goto("/conexion");
    await expect(page.getByRole("alert").filter({ hasText: LOST })).toHaveCount(0);
  }

  d1(`UPDATE broker_connection SET status = 'CONNECTED' WHERE user_id = '${userId}'`);
  await page.goto("/posiciones");
  await expect(page.locator("header.topbar")).toContainText("TradeStation conectado");
  await expect(page.getByRole("alert").filter({ hasText: LOST })).toHaveCount(0);
  await expect(page.getByText(/Datos sin verificar/)).toHaveCount(0);
});

test("asks a client who never connected to connect", async ({ context, page }) => {
  await seedSignedInUser(context);
  await page.goto("/operar");
  const alert = page.getByRole("alert").filter({ hasText: "Conecta tu cuenta de TradeStation" });
  await expect(alert).toContainText("para operar");
  await expect(alert.getByRole("link", { name: "Conectar con TradeStation" })).toHaveAttribute(
    "href",
    "/conexion",
  );
});
