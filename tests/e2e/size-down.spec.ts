import { expect, test } from "./test.ts";
import { type Page } from "@playwright/test";
import { SETTLE_MS, seedTradingClient, origin } from "./support.ts";
import { openEntry, send } from "./trading.ts";

// D51: before sending, the client may size one entry down by 25%. The engine runs the local
// simulation with its clock pinned inside a regular session (tests/e2e/engine.env): MSFT asks
// US$101, so SIZE US$20,000 buys 198 shares and the reduced US$15,000 buys 148.
// Set SCREENSHOT_DIR to also write desktop and mobile screenshots of each state.
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

test("sizes one entry at 75% of the SIZE, sends it, and shows the applied SIZE in Historial", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openEntry(page, "MSFT");
  const rows = page.locator(".form dl");
  const summary = page.locator(".summary");
  const choice = page.getByRole("navigation", { name: "Opciones de tamaño" });

  // Every new entry starts at the full SIZE.
  await expect(choice.getByRole("link", { name: "Normal" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(rows).toContainText("US$20,000");
  await expect(rows).toContainText("198 acciones");
  await shoot(page, "size-normal");

  await choice.getByRole("link", { name: "−25%" }).click();
  await expect(page).toHaveURL(/tamano=down25/);
  await expect(choice.getByRole("link", { name: "−25%" })).toHaveAttribute("aria-current", "true");
  await expect(rows).toContainText("US$15,000");
  await expect(rows).toContainText("148 acciones");
  await expect(summary).toContainText("US$15,000");
  await expect(summary).toContainText("148 acciones");
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeEnabled({
    timeout: SETTLE_MS,
  });
  await shoot(page, "size-down25");

  // Looking up another symbol keeps the choice of this entry.
  await page.getByLabel("Símbolo").fill("AAPL");
  await page.getByRole("button", { name: "Consultar" }).click();
  await expect(page).toHaveURL(/tamano=down25/);
  await expect(page).toHaveURL(/simbolo=AAPL/);
  await page.goto("/operar?simbolo=MSFT&tamano=down25", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeEnabled({
    timeout: SETTLE_MS,
  });

  await send(page);
  await expect(page.getByRole("status")).toContainText("148", { timeout: SETTLE_MS });

  await page.goto("/historial");
  const table = page.getByRole("table", { name: /Órdenes/ });
  await expect(table.getByRole("row").nth(1)).toContainText("US$15,000 · −25%");
  await expect(table.getByRole("row").nth(1)).toContainText("148 acciones");
  await shoot(page, "size-historial");

  // The next entry is back at the full SIZE, and the configured SIZE did not change.
  await page.goto("/operar?simbolo=SLOW", { waitUntil: "networkidle" });
  await expect(page.locator(".form dl")).toContainText("US$20,000");
  await expect(page.getByRole("link", { name: "Normal" })).toHaveAttribute("aria-current", "true");
});

test("accepts only the closed choices from the browser", async ({ context, page }) => {
  await seedTradingClient(context);
  for (const value of ["down50", "25", "75", "down25%", ""]) {
    const response = await page.goto(`/operar?simbolo=MSFT&tamano=${value}`);
    expect(response?.status(), value).toBe(400);
  }
  const ok = await page.goto("/operar?simbolo=MSFT&tamano=full");
  expect(ok?.status()).toBe(200);
  await expect(page.locator(".form dl")).toContainText("198 acciones");
});

test("a post names only the choice: another choice is refused and a stale quantity is re-confirmed", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openEntry(page, "MSFT");
  const intentId = await page.locator("input[name=intentId]").inputValue();
  const post = (extra: Record<string, string>) =>
    page.request.post("/operar?tipo=acciones&cuenta=SIM-1&simbolo=MSFT&/enviar", {
      form: {
        tipo: "acciones",
        cuenta: "SIM-1",
        simbolo: "MSFT",
        intentId,
        cantidad: "198",
        ...extra,
      },
      headers: { origin: origin, accept: "text/html" },
      maxRedirects: 0,
    });

  // An amount or a percentage is not a choice.
  for (const tamano of ["down50", "75", "15000"]) {
    expect((await post({ tamano })).status(), tamano).toBe(400);
  }
  // The screen showed 198 shares (full SIZE); at -25% the engine sizes 148 and sends nothing.
  const reduced = await post({ tamano: "down25" });
  expect(reduced.status()).toBe(200);
  expect(await reduced.text()).toContain("La cantidad cambió");
  await page.goto("/historial");
  await expect(page.getByText("Aún no tienes órdenes")).toBeVisible();
});
