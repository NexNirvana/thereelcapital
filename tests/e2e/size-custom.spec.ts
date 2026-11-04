import { expect, test } from "./test.ts";
import { d1, SETTLE_MS, seedTradingClient, origin } from "./support.ts";
import { openEntry, send } from "./trading.ts";

// D53: with the admin's switch on, the client types the SIZE of one entry in whole dollars. The
// engine runs the local simulation with its clock pinned inside a regular session
// (tests/e2e/engine.env): MSFT asks US$101, so US$5,000 buys 49 shares. The switch is set straight
// in D1 here; the admin form that sets it is exercised in admin-client-access.spec.ts.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

test.beforeEach(async ({ context }) => {
  const ip = `10.7.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: origin });
});

const allow = (userId: string) =>
  d1(`UPDATE client_settings SET client_sets_size = 1 WHERE user_id = '${userId}'`);

test("sizes one entry at a typed amount, sends it, and shows the applied SIZE in Historial", async ({
  context,
  page,
}) => {
  allow(await seedTradingClient(context));
  await openEntry(page, "MSFT");
  const rows = page.locator(".form dl");
  const choice = page.getByRole("navigation", { name: "Opciones de tamaño" });

  await choice.getByRole("link", { name: "Monto propio" }).click();
  await expect(page).toHaveURL(/tamano=custom/);
  const amount = page.getByLabel("Monto en dólares");
  await expect(amount).toHaveValue("20000");
  await amount.fill("5000");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await expect(page).toHaveURL(/importe=5000/);
  await expect(rows).toContainText("US$5,000");
  await expect(rows).toContainText("49 acciones");
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeEnabled({
    timeout: SETTLE_MS,
  });
  if (SCREENSHOT_DIR) {
    for (const [width, height, label] of [
      [1440, 900, "desktop"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `${SCREENSHOT_DIR}/size-custom-${label}.png`, fullPage: true });
    }
  }

  // Above the configured SIZE the entry is blocked and nothing can be sent.
  await page.goto("/operar?simbolo=MSFT&tamano=custom&importe=20001", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeDisabled();

  await page.goto("/operar?simbolo=MSFT&tamano=custom&importe=5000", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeEnabled({
    timeout: SETTLE_MS,
  });
  await send(page);
  await expect(page.getByRole("status")).toContainText("49", { timeout: SETTLE_MS });

  await page.goto("/historial");
  const row = page
    .getByRole("table", { name: /Órdenes/ })
    .getByRole("row")
    .nth(1);
  await expect(row).toContainText("US$5,000 · monto propio");
  await expect(row).toContainText("49 acciones");

  // The next entry is back at the full SIZE.
  await page.goto("/operar?simbolo=SLOW", { waitUntil: "networkidle" });
  await expect(page.locator(".form dl")).toContainText("US$20,000");
});

test("with the switch off the field is hidden and the server refuses a hand-made request", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openEntry(page, "MSFT");
  await expect(page.getByRole("link", { name: "Monto propio" })).toHaveCount(0);

  await page.goto("/operar?simbolo=MSFT&tamano=custom&importe=5000", { waitUntil: "networkidle" });
  await expect(page.getByLabel("Monto en dólares")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeDisabled();

  const post = await page.request.post("/operar?tipo=acciones&cuenta=SIM-1&simbolo=MSFT&/enviar", {
    form: {
      modo: "SIM",
      tipo: "acciones",
      cuenta: "SIM-1",
      simbolo: "MSFT",
      intentId: "A".repeat(22),
      cantidad: "49",
      tamano: "custom",
      importe: "5000",
    },
    headers: { origin: origin, accept: "text/html" },
    maxRedirects: 0,
  });
  expect(post.status()).not.toBe(303);
  await page.goto("/historial");
  await expect(page.getByText("Aún no tienes órdenes")).toBeVisible();
});
