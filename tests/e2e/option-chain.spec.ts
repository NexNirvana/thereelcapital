import { expect, test } from "./test.ts";
import { type Page } from "@playwright/test";
import { seedTradingClient, origin } from "./support.ts";

// The engine runs the local simulation (tests/e2e/engine.env). Its dev MSFT trades at 100 / 101 and
// its chain has two Friday expirations with 100, 105, 395, 400 and 405 calls and puts; the 405 put
// is listed with no market.
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

async function shoot360(page: Page) {
  if (SCREENSHOT_DIR)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/opciones-360.png`, fullPage: true });
}

async function openChain(page: Page) {
  // Typing before the page hydrates is lost when it takes over the field.
  await page.goto("/operar?tipo=opciones", { waitUntil: "networkidle" });
  // No Buscar click: the search starts by itself once the typing stops.
  await page.getByRole("textbox", { name: "Subyacente" }).fill("msft");
  await expect(page).toHaveURL(/subyacente=MSFT/);
  // With no date typed the chain opens on today's expiration, or on the next one.
  await expect(page.getByRole("table")).toBeVisible();
}

test("picks a CALL from the chain without leaving /operar and fills the summary", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openChain(page);
  await expect(page.getByText("Datos de las 10:00:00")).toBeVisible();
  // The price line comes from TradeStation's quote (the simulated MSFT trades at 100 / 101).
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(1)).toContainText("MSFT 101.00");
  await expect(page.locator("tbody tr.spot")).toHaveCount(1);
  await expect(rows.nth(4)).toContainText("400");
  await expect(rows.nth(4)).toContainText("7.00 / 7.10");
  await expect(page.getByText(/^Mostrando los 5 strikes \(100–405\)/)).toBeVisible();
  await shoot(page, "opciones-cadena");

  await page.getByRole("link", { name: /^Elegir Call 400/ }).click();
  await expect(page).toHaveURL(/\/operar\?.*tipo=opciones/);
  await expect(page).toHaveURL(/simbolo=/);
  await expect(page).not.toHaveURL(/\/cadena/);
  const symbol = new URL(page.url()).searchParams.get("simbolo") ?? "";
  expect(symbol).toMatch(/^MSFT \d{6}C400$/);
  // The chain stays on screen with the picked price marked.
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Elegir Call 400/ })).toHaveAttribute(
    "aria-current",
    "true",
  );

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
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeEnabled();
  await expect(page.getByRole("link", { name: /Cambiar contrato/ })).toHaveCount(0);
  await shoot(page, "opciones-contrato");
});

test("the old chain address redirects to the Opciones tab", async ({ context, page }) => {
  await seedTradingClient(context);
  await page.goto("/operar/cadena?subyacente=MSFT&cuenta=SIM-1");
  await expect(page).toHaveURL(/\/operar\?tipo=opciones&cuenta=SIM-1&subyacente=MSFT/);
  await expect(page.getByRole("table")).toBeVisible();
});

test("shades the money side of each strike by the price and shows the price line", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openChain(page);
  // Price 101: calls are in the money below it, puts above it.
  const first = page.locator("tbody tr").first();
  await expect(first).toContainText("100");
  await expect(first.locator("td.call.itm")).toHaveCount(1);
  await expect(first.locator("td.put.itm")).toHaveCount(0);
  // The strikes above the price are the other way round.
  const last = page.locator("tbody tr").last();
  await expect(last.locator("td.put.itm")).toHaveCount(1);
  await expect(last.locator("td.call.itm")).toHaveCount(0);
});

test("the Strike field suggests matching strikes by distance to the price and highlights the pick", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openChain(page);
  const field = page.getByRole("combobox", { name: "Strike" });
  await field.fill("40");
  const options = page.getByRole("listbox", { name: "Strike" }).getByRole("option");
  await expect(options).toHaveText(["400", "405"]);
  await field.press("ArrowDown");
  await expect(field).toHaveAttribute("aria-activedescendant", /-1$/);
  await field.press("Enter");
  await expect(field).toHaveValue("405");
  await expect(page).toHaveURL(/strike=405/);
  await expect(page.locator("tbody tr.hit")).toContainText("405");
  await expect(page.getByText(/con el 405 resaltado\.$/)).toBeVisible();

  // Nothing matches: the nearest strike below and above.
  await field.fill("300");
  await expect(options).toContainText(["105", "395"]);
  await expect(page.getByText("más cercano")).toHaveCount(2);
  // Clearing the field centers on the price again.
  await field.fill("");
  await field.press("Enter");
  await expect(page).not.toHaveURL(/strike=/);
  await expect(
    page.getByText(/centrados en el precio actual|Mostrando los 5 strikes \(100–405\)\.$/),
  ).toBeVisible();
});
test("shows a side without a market as missing and does not offer it", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openChain(page);
  const last = page.locator("tbody tr").nth(5);
  await expect(last).toContainText("405");
  await expect(last.getByText("Sin dato")).toHaveCount(1);
  await expect(last).not.toContainText("0.00");
  await expect(last.getByRole("link")).toHaveCount(1);
  await expect(page.getByRole("link", { name: /^Elegir Put 405/ })).toHaveCount(0);
  await shoot(page, "opciones-sin-dato");
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
  await shoot(page, "opciones-desactualizada");

  await page.getByRole("button", { name: "Actualizar" }).click();
  await expect(freshness).toContainText("hace 0 s");
  await expect(freshness).not.toContainText("desactualizados");
});

test("refuses unknown parameters and underlyings without options", async ({ context, page }) => {
  await seedTradingClient(context);
  const response = await page.goto("/operar?tipo=opciones&subyacente=MSFT&precio=1");
  expect(response?.status()).toBe(400);
  await page.goto("/operar?tipo=opciones&subyacente=ZZZZ");
  await expect(page.getByRole("alert")).toContainText("No encontramos eso en TradeStation.");
  await page.goto("/operar?tipo=opciones&subyacente=%3Cscript%3E");
  await expect(page.getByRole("alert")).toContainText("Escribe el ticker");
  // The search also starts on its own for a symbol that does not exist.
  await page.goto("/operar?tipo=opciones", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Subyacente" }).fill("zzzz");
  await expect(page.getByRole("alert")).toContainText("No encontramos eso en TradeStation.");
});

test("opens on the next expiration when there is none today and says so", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openChain(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Hoy no hay vencimiento para MSFT" }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Vencimiento" })).toHaveValue(/ · en \d+ días$/);
  await shoot(page, "opciones-vencimiento");
});

test("the Vencimiento field suggests only listed dates and explains a date that is not listed", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await openChain(page);
  const field = page.getByRole("combobox", { name: "Vencimiento" });
  await field.click();
  const options = page.getByRole("option");
  expect(await options.count()).toBeGreaterThan(1);
  await expect(field).toHaveAttribute("aria-expanded", "true");

  await field.press("ArrowDown");
  await expect(field).toHaveAttribute("aria-activedescendant", /-1$/);
  await field.press("Escape");
  await expect(field).toHaveAttribute("aria-expanded", "false");

  await field.fill("2020-01-02");
  await expect(page.getByText(/^No hay vencimiento el 2 ene 2020/)).toBeVisible();
  await shoot(page, "opciones-vencimiento-inexistente");
  await field.fill("");
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(page).toHaveURL(/vencimiento=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole("table")).toBeVisible();
});

test("«Ver vencimiento» submits what was typed", async ({ context, page }) => {
  await seedTradingClient(context);
  await openChain(page);
  const field = page.getByRole("combobox", { name: "Vencimiento" });
  await field.fill("2020-01-02");
  await page.getByRole("button", { name: "Ver vencimiento" }).click();
  await expect(page).toHaveURL(/vencimiento=2020-01-02/);
  await expect(page.getByText(/^No hay vencimiento el 2 ene 2020/)).toBeVisible();
});

test("«Ver vencimiento» keeps the one-entry SIZE choice", async ({ context, page }) => {
  await seedTradingClient(context);
  await openChain(page);
  await page.getByRole("link", { name: "−25%" }).click();
  await expect(page).toHaveURL(/tamano=down25/);
  await page.getByRole("combobox", { name: "Vencimiento" }).fill("2020-01-02");
  await page.getByRole("button", { name: "Ver vencimiento" }).click();
  await expect(page).toHaveURL(/vencimiento=2020-01-02/);
  await expect(page).toHaveURL(/tamano=down25/);
});

test("works as a plain GET form and the server refuses a date it does not list", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await page.goto("/operar?tipo=opciones&subyacente=MSFT&vencimiento=2020-01-02");
  await expect(page.getByText(/^No hay vencimiento el 2 ene 2020/)).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.goto("/operar?tipo=opciones&subyacente=MSFT&vencimiento=abc");
  await expect(page.getByText(/^No reconozco esa fecha/)).toBeVisible();
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
  await expect(page.locator("tbody tr").nth(4)).toContainText("7.25 / 7.35", { timeout: 8_000 });
  await expect(page.getByText("se actualizan solos")).toBeVisible();
  await shoot(page, "opciones-viva");

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
  await page.goto("/operar?tipo=opciones&subyacente=MSFT");
  await page.getByRole("combobox", { name: "Vencimiento" }).click();
  await page.getByRole("option").first().click();
  await expect(page).toHaveURL(/vencimiento=\d{4}-\d{2}-\d{2}/);
  const expiration = new URL(page.url()).searchParams.get("vencimiento") ?? "";
  expect(expiration).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const ok = await page.request.get(`${href}${expiration}`);
  expect(ok.status()).toBe(200);
  expect(ok.headers()["cache-control"]).toBe("no-store");
  const body = await ok.json();
  expect(body.status).toBe("ready");
  expect(body.chain.strikes).toHaveLength(5);
  expect(body.chain.strikes[4].put).toBeNull();

  for (const extra of ["simbolo=MSFT", "precio=1", "qty=5"]) {
    expect((await page.request.get(`${href}${expiration}&${extra}`)).status()).toBe(400);
  }
  expect((await page.request.get(`${href}ayer`)).status()).toBe(400);
});

test("shows every field in full at 360 px, with one style and no sideways scroll", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  await page.setViewportSize({ width: 360, height: 800 });
  await openChain(page);
  await page.getByRole("combobox", { name: "Strike" }).fill("400");
  const fields = page.locator("input.field-input");
  expect(await fields.count()).toBeGreaterThanOrEqual(4);
  const boxes = await fields.evaluateAll((els) =>
    els.map((el) => {
      const input = el as HTMLInputElement;
      const style = getComputedStyle(input);
      return {
        height: Math.round(input.getBoundingClientRect().height),
        border: style.borderTopWidth + style.borderTopStyle + style.borderTopColor,
        id: input.id,
        value: input.value,
        scroll: input.scrollWidth + "/" + input.clientWidth,
        overflowing: input.scrollWidth > input.clientWidth,
        right: Math.round(input.getBoundingClientRect().right),
      };
    }),
  );
  expect(new Set(boxes.map((box) => box.height)).size).toBe(1);
  expect(new Set(boxes.map((box) => box.border)).size).toBe(1);
  for (const box of boxes) {
    expect(box.overflowing, JSON.stringify(box)).toBe(false);
    expect(box.right).toBeLessThanOrEqual(360);
  }
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sideways).toBeLessThanOrEqual(0);
  await shoot360(page);
});

test("a client with two accounts picks one on the Opciones tab and the chain keeps its state", async ({
  context,
  page,
}) => {
  await seedTradingClient(context, { accounts: ["SIM-1", "SIM-2"] });
  await page.goto("/operar?tipo=opciones&subyacente=MSFT", { waitUntil: "networkidle" });
  const account = page.getByLabel("Cuenta");
  await expect(account).toHaveValue("SIM-1");
  await page.getByRole("link", { name: /^Elegir Call 400/ }).click();
  await expect(page).toHaveURL(/simbolo=/);
  const before = new URL(page.url()).searchParams;
  await account.selectOption("SIM-2");
  await expect(page).toHaveURL(/cuenta=SIM-2/);
  const after = new URL(page.url()).searchParams;
  for (const name of ["subyacente", "vencimiento", "simbolo"]) {
    expect(after.get(name)).toBe(before.get(name));
  }
  await expect(page.getByRole("link", { name: /^Elegir Call 400/ })).toHaveAttribute(
    "href",
    /cuenta=SIM-2/,
  );
  await expect(page.getByRole("button", { name: "Enviar orden" })).toBeEnabled();
});
