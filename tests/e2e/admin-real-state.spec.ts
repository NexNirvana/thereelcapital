import { expect, test } from "./test.ts";
import { type Page } from "@playwright/test";
import { d1, origin, seedSignedInUser, seedTradingClient } from "./support.ts";

// The local simulation opens REAL_TRADING (tests/e2e/engine.env); the admin flag is written to D1
// directly. Set SCREENSHOT_DIR for desktop and mobile shots. The closed-deployment state needs a
// closed switch, which this stack never has: it is covered by the server tests with a stubbed engine.
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

const setFlag = (userId: string, enabled: 0 | 1) =>
  d1(`UPDATE client_settings SET real_trading_enabled = ${enabled} WHERE user_id = '${userId}'`);

test("shows the effective REAL state of a client and reads either mode", async ({
  context,
  page,
}) => {
  const userId = await seedTradingClient(context, {
    positions: [{ id: "p-sim", symbol: "MSFT", qty: 10 }],
  });
  await seedSignedInUser(context, { role: "admin" });
  const section = page.getByRole("region", { name: "Modo REAL" });
  const operations = page.getByRole("region", { name: /Conexión y posiciones/ });

  await page.goto(`/admin/clientes/${userId}`);
  await expect(section.getByText("Inactivo, o REAL cerrado en este despliegue")).toBeVisible();
  await expect(operations.getByRole("heading", { name: /· SIM/ })).toBeVisible();
  await expect(operations.getByRole("row", { name: /MSFT/ })).toBeVisible();
  await shoot(page, "cliente-sim-real-inactivo");

  setFlag(userId, 1);
  await page.goto(`/admin/clientes/${userId}?modo=REAL`);
  await expect(
    section.getByText("Activo: acepta entradas, salidas y protecciones REAL"),
  ).toBeVisible();
  await expect(operations.getByRole("heading", { name: /· REAL/ })).toBeVisible();
  await expect(operations.getByRole("link", { name: "REAL" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // SIM data does not leak into the REAL view.
  await expect(operations.getByRole("row", { name: /MSFT/ })).toHaveCount(0);
  await shoot(page, "cliente-real-activo");
});

test("tells how many REAL accounts were skipped without naming the holder", async ({
  context,
  page,
}) => {
  const [skipped, clean, none] = [
    await seedTradingClient(context, { realListing: { stored: 1, skipped: 2 } }),
    await seedTradingClient(context, { realListing: { stored: 1, skipped: 0 } }),
    await seedTradingClient(context),
  ];
  await seedSignedInUser(context, { role: "admin" });
  const listing = (id: string) =>
    page.goto(`/admin/clientes/${id}?modo=REAL`).then(() => page.getByText(/Listado REAL/));
  await listing(skipped);
  await expect(
    page.getByText("2 cuentas de esta conexión ya pertenecen a otro cliente y no se usan aquí"),
  ).toBeVisible();
  await shoot(page, "cliente-real-cuentas-omitidas");
  await listing(clean);
  await expect(page.getByText("Sin cuentas omitidas")).toBeVisible();
  await listing(none);
  await expect(page.getByText("Aún sin listar")).toBeVisible();
});

test("allows only exits when the switch is off with REAL positions open", async ({
  context,
  page,
}) => {
  const userId = await seedTradingClient(context, {
    positions: [{ id: "p-real", mode: "REAL", symbol: "NVDA", qty: 5, account: "REAL-1" }],
  });
  await seedSignedInUser(context, { role: "admin" });
  setFlag(userId, 0);
  await page.goto(`/admin/clientes/${userId}?modo=REAL`);
  await expect(
    page.getByRole("region", { name: "Modo REAL" }).getByText(/^Solo salidas/),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: /Conexión y posiciones/ }).getByRole("row", { name: /NVDA/ }),
  ).toBeVisible();
  await shoot(page, "cliente-real-solo-salidas");
});

test("labels the mode on the fleet and history pages and rejects an unknown mode", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await seedSignedInUser(context, { role: "admin" });
  await page.goto("/admin/operativa?modo=REAL");
  await expect(page.getByRole("link", { name: "REAL", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText(/^Modo REAL · Conexión:/).first()).toBeVisible();
  await shoot(page, "operativa-real");

  await page.goto("/admin/historial?modo=REAL");
  await expect(page.getByLabel("Modo")).toHaveValue("REAL");
  await expect(page.getByText("REAL · Dinero real")).toBeVisible();
  await shoot(page, "historial-real");

  expect((await page.request.get("/admin/operativa?modo=LIVE")).status()).toBe(400);
  expect((await page.request.get("/admin/clientes/x?modo=LIVE")).status()).toBeGreaterThanOrEqual(
    400,
  );
});
