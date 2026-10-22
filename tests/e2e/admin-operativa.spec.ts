import { expect, test, type Page } from "@playwright/test";
import { ENGINE_NOW, seedPendingClient, seedSignedInUser, seedTradingClient } from "./support.ts";

// Each client is seeded into D1 and its own Durable Object (no order UI exists yet), then an admin
// reads them through the engine's `overview`. Set SCREENSHOT_DIR for desktop and mobile shots.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;
const HOUR = 3_600_000;

test.beforeEach(async ({ context }) => {
  const ip = `10.9.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: "http://localhost:8790" });
});

// The local D1 keeps every client earlier specs created; the shots show only this test's fleet.
async function shoot(page: Page, name: string, keep: readonly string[]) {
  if (!SCREENSHOT_DIR) return;
  const scope = page.url().endsWith("/admin")
    ? "table:not([aria-label]) tbody tr"
    : "main section[aria-labelledby^=client-]";
  if (keep.length > 0) {
    await page.evaluate(
      ([selector, ids]) => {
        for (const node of document.querySelectorAll(selector as string)) {
          if (!(ids as string[]).some((id) => node.textContent?.includes(id))) node.remove();
        }
      },
      [scope, keep] as const,
    );
  }
  for (const [width, height, label] of [
    [1440, 900, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}-${label}.png`, fullPage: true });
  }
}

async function seedFleet(context: Parameters<typeof seedSignedInUser>[0], page: Page) {
  const ok = await seedTradingClient(context, page, {
    accounts: ["SIM-1001", "SIM-1002"],
    positions: [
      { id: "p-msft", symbol: "MSFT", qty: 100, soldQty: 30, protectionState: "unverified" },
      { id: "p-aapl", symbol: "AAPL", qty: 50 },
    ],
    orders: [
      {
        id: "o-unknown",
        symbol: "MSFT",
        state: "UNKNOWN",
        qty: 20,
        kind: "exit",
        createdAt: ENGINE_NOW - 1000,
      },
      {
        id: "o-sent",
        symbol: "NVDA",
        state: "SENT",
        qty: 10,
        kind: "exit",
        createdAt: ENGINE_NOW - 2000,
      },
      { id: "o-done", symbol: "TSLA", state: "FILLED", qty: 5, createdAt: ENGINE_NOW - 3000 },
    ],
    entriesToday: 2,
    refreshExpiresAt: ENGINE_NOW + 10 * HOUR,
  });
  const expiring = await seedTradingClient(context, page, { refreshExpiresAt: ENGINE_NOW + HOUR });
  const expired = await seedTradingClient(context, page, { status: "EXPIRED" });
  const revoked = await seedTradingClient(context, page, { status: "REVOKED" });
  const errored = await seedTradingClient(context, page, { status: "ERROR" });
  const pending = await seedPendingClient();
  await seedSignedInUser(context, { role: "admin" });
  return { ok, expiring, expired, revoked, errored, pending: pending.userId };
}

const email = (id: string) => `${id}@example.com`;

test("keeps /admin/operativa closed to clients and to anyone not signed in", async ({
  context,
  page,
}) => {
  const anonymous = await page.request.get("/admin/operativa", { maxRedirects: 0 });
  expect(anonymous.status()).toBe(303);
  await seedSignedInUser(context, { role: "user" });
  expect((await page.request.get("/admin/operativa")).status()).toBe(403);
});

test("shows every client's connection, positions, orders and counts on /admin/operativa", async ({
  context,
  page,
}) => {
  const fleet = await seedFleet(context, page);
  await page.goto("/admin/operativa");
  await expect(page.getByRole("heading", { name: "Operativa", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Operativa" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const section = (id: string) =>
    page.locator("section").filter({ has: page.getByRole("link", { name: email(id) }) });
  const ok = section(fleet.ok);
  await expect(ok).toContainText("Conexión: Conectado");
  await expect(ok).toContainText("Posiciones 2/2");
  await expect(ok).toContainText("Entradas hoy 2/3");
  const positions = ok.getByRole("table").first();
  await expect(positions.getByRole("row", { name: /MSFT.*70.*30.*No verificado/ })).toBeVisible();
  await expect(positions.getByRole("row", { name: /AAPL.*50.*Sin activar/ })).toBeVisible();
  await expect(ok.getByRole("alert")).toContainText("Órdenes sin verificar");
  const orders = ok.getByRole("table").nth(1);
  await expect(orders.getByRole("row", { name: /MSFT.*Salida.*No verificada/ })).toBeVisible();
  await expect(orders.getByRole("row", { name: /NVDA.*Salida.*Enviada/ })).toBeVisible();
  await expect(orders.getByRole("row", { name: /TSLA/ })).toHaveCount(0);

  await expect(section(fleet.expiring)).toContainText("Conexión: Vence pronto");
  await expect(section(fleet.expired)).toContainText("Conexión: Venció");
  await expect(section(fleet.revoked)).toContainText("Conexión: Sin acceso");
  await expect(section(fleet.errored)).toContainText("Conexión: Sin respuesta");
  await expect(section(fleet.pending)).toContainText("Conexión: Sin conectar");
  await expect(section(fleet.pending)).toContainText("Sin posiciones abiertas.");

  const html = await page.content();
  expect(html).not.toMatch(/refresh_token|client_secret|access_token|SECRET/i);
  await shoot(page, "operativa", Object.values(fleet).map(email));
});

test("shows the real connection state in the client list", async ({ context, page }) => {
  const fleet = await seedFleet(context, page);
  await page.goto("/admin");
  const row = (id: string) => page.getByRole("row", { name: new RegExp(email(id)) });
  await expect(row(fleet.ok)).toContainText("Conectado");
  await expect(row(fleet.expiring)).toContainText("Vence pronto");
  await expect(row(fleet.expired)).toContainText("Venció");
  await expect(row(fleet.revoked)).toContainText("Sin acceso");
  await expect(row(fleet.errored)).toContainText("Sin respuesta");
  await expect(row(fleet.pending)).toContainText("Sin conectar");
  await expect(page.getByRole("link", { name: "Clientes" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await shoot(page, "clientes", Object.values(fleet).map(email));
});

test("fills «Conexión y posiciones» on the client detail", async ({ context, page }) => {
  const fleet = await seedFleet(context, page);
  await page.goto(`/admin/clientes/${fleet.ok}`);
  const section = page.locator("section[aria-labelledby=operations]");
  await expect(section.getByRole("heading", { name: "Conexión y posiciones" })).toBeVisible();
  await expect(section).toContainText("Estado");
  await expect(section).toContainText("Conectado");
  await expect(section).toContainText("SIM-1001 (Margin), SIM-1002 (Margin)");
  await expect(section).toContainText("Vence");
  await expect(section).toContainText("Última conexión correcta");
  await expect(section.getByRole("row", { name: /MSFT/ }).first()).toBeVisible();
  await expect(section.getByRole("alert")).toContainText("Órdenes sin verificar");
  expect(await page.content()).not.toMatch(/refresh_token|client_secret|access_token/i);
  await shoot(page, "cliente-conexion", []);

  await page.goto(`/admin/clientes/${fleet.pending}`);
  await expect(page.locator("section[aria-labelledby=operations]")).toContainText("Sin conectar");
});
