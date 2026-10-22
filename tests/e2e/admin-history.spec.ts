import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  ENGINE_NOW,
  d1,
  seedSignedInUser,
  seedTradingClient,
  type SeededOrder,
  origin,
} from "./support.ts";

// Set SCREENSHOT_DIR for screenshots at desktop and mobile width.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

test.beforeEach(async ({ context }) => {
  const ip = `10.9.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
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

// The local D1 and Durable Objects persist between runs: symbols carry a per-run tag.
const newTag = () => `Z${randomUUID().slice(0, 6).replaceAll("-", "").toUpperCase()}`;

// Orders of every run must sort ahead of those of earlier runs: one minute of "engine time" per
// real second keeps each run's rows (a few seconds apart at most) newer than the last run's.
const NOW =
  ENGINE_NOW +
  3_600_000 +
  Math.floor((Date.now() - Date.parse("2026-10-21T00:00:00Z")) / 1000) * 60_000;
const emailOf = (userId: string) => `${userId}@example.com`;

test("keeps both admin screens closed to clients and to anyone not signed in", async ({
  context,
  page,
}) => {
  for (const path of ["/admin/historial", "/admin/auditoria"]) {
    const anonymous = await page.request.get(path, { maxRedirects: 0 });
    expect(anonymous.status()).toBe(303);
  }
  await seedSignedInUser(context, { role: "user" });
  for (const path of ["/admin/historial", "/admin/auditoria"]) {
    expect((await page.request.get(path)).status()).toBe(403);
  }
});

test("lists orders across clients and narrows by client, symbol, state and type", async ({
  context,
  page,
}) => {
  const tag = newTag();
  const alice = await seedTradingClient(context, {
    orders: [
      {
        id: "al1",
        symbol: `${tag}AA`,
        state: "FILLED",
        qty: 10,
        filledQty: 10,
        avgFillPrice: 101_250_000,
        createdAt: NOW - 1000,
      },
      { id: "al2", symbol: `${tag}BB`, state: "REJECTED", qty: 5, createdAt: NOW - 2000 },
    ],
  });
  const bob = await seedTradingClient(context, {
    orders: [
      {
        id: "bo1",
        symbol: `${tag}CC`,
        state: "PARTIAL",
        qty: 20,
        filledQty: 8,
        createdAt: NOW - 3000,
      },
    ],
  });
  await seedSignedInUser(context, { role: "admin" });

  await page.goto("/admin/historial");
  await expect(page.getByRole("heading", { name: "Historial", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Historial" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: "Auditoría" })).toBeVisible();
  const orders = page.getByRole("table", { name: /Órdenes/ });
  for (const symbol of [`${tag}AA`, `${tag}BB`, `${tag}CC`])
    await expect(orders).toContainText(symbol);
  const filled = orders.getByRole("row").filter({ hasText: `${tag}AA` });
  await expect(filled).toContainText(emailOf(alice));
  await expect(filled).toContainText("10/10");
  await expect(filled).toContainText("US$101.25");
  await expect(page.getByRole("table", { name: /Eventos/ })).toContainText(emailOf(alice));
  await page.goto(`/admin/historial?cliente=${alice}`);
  await shoot(page, "historial");
  await page.goto("/admin/historial");

  await page.getByLabel("Cliente").selectOption(bob);
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(orders).toContainText(`${tag}CC`);
  await expect(orders).not.toContainText(`${tag}AA`);

  await page.goto("/admin/historial");
  await page.getByLabel("Estado").selectOption("REJECTED");
  await page.getByLabel("Símbolo").fill(`${tag}BB`.toLowerCase());
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(orders.getByRole("row")).toHaveCount(2);
  await expect(orders).toContainText("Rechazada");

  await page.goto("/admin/historial?tipo=eventos");
  await expect(page.getByRole("table", { name: /Órdenes/ })).toHaveCount(0);
  await expect(page.getByRole("table", { name: /Eventos/ })).toBeVisible();
  await page.goto(`/admin/historial?tipo=errores&cliente=${alice}`);
  await expect(page.getByText("No hay errores con estos filtros.")).toBeVisible();
});

test("paginates the merged orders", async ({ context, page }) => {
  const tag = newTag();
  const orders: SeededOrder[] = Array.from({ length: 30 }, (_, i) => ({
    id: `pg${String(i).padStart(2, "0")}`,
    symbol: tag,
    state: "FILLED",
    qty: 1,
    filledQty: 1,
    createdAt: NOW - 1000 * (i + 1),
  }));
  await seedTradingClient(context, { orders });
  await seedSignedInUser(context, { role: "admin" });
  await page.goto(`/admin/historial?simbolo=${tag}`);
  const table = page.getByRole("table", { name: /Órdenes/ });
  await expect(table.getByRole("row")).toHaveCount(26);
  await page.getByRole("link", { name: /Ver órdenes anteriores/ }).click();
  await expect(table.getByRole("row").filter({ hasText: tag })).toHaveCount(5);
  await expect(page.getByRole("link", { name: /Ver órdenes anteriores/ })).toHaveCount(0);
});

test("rejects unknown or malformed history parameters", async ({ context, page }) => {
  await seedSignedInUser(context, { role: "admin" });
  expect((await page.request.get("/admin/historial?modo=REAL")).status()).toBe(400);
  expect((await page.request.get("/admin/historial?extra=1")).status()).toBe(400);
  expect((await page.request.get("/admin/auditoria?despues=x;y")).status()).toBe(400);
});

test("shows the audit log as text, filtered and without credentials", async ({ context, page }) => {
  const admin = await seedSignedInUser(context, { role: "admin" });
  const marker = randomUUID().slice(0, 8);
  const action = `e2e.change_${marker}`;
  const xss = `<img src=x onerror="window.__pwned=1"> ${marker}`;
  const at = Date.now();
  d1(
    `INSERT INTO audit_log (id, at, actor_id, action, target_user_id, before_json, after_json) VALUES
     ('${randomUUID()}', ${at}, '${admin}', '${action}', NULL, '{"size_usd":100}', '${JSON.stringify({ size_usd: 200, note: xss, refresh_token: "must-not-show" }).replaceAll("'", "''")}'),
     ('${randomUUID()}', ${at - 1000}, '${admin}', 'e2e.other_${marker}', NULL, NULL, NULL)`,
  );

  await page.goto("/admin/auditoria");
  await expect(page.getByRole("heading", { name: "Auditoría", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Auditoría" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByLabel("Acción").selectOption(action);
  await page.getByRole("button", { name: "Filtrar" }).click();
  const table = page.getByRole("table", { name: /auditoría/i });
  await expect(table.getByRole("row")).toHaveCount(2);
  const row = table.getByRole("row").nth(1);
  await expect(row).toContainText(emailOf(admin));
  await expect(row).toContainText('{"size_usd":100}');
  await expect(row).toContainText("<img src=x onerror=");
  await expect(row).toContainText('"refresh_token":"••••"');
  await expect(page.locator("main img")).toHaveCount(0);
  expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
  expect(await page.content()).not.toContain("must-not-show");
  await shoot(page, "auditoria");
});
