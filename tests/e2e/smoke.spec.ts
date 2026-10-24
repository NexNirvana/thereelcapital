import { expect, test } from "./test.ts";
import { seedSignedInUser } from "./support.ts";

test("the shell is served from /operar and / redirects there", async ({
  context,
  page,
  baseURL,
}) => {
  await seedSignedInUser(context);
  // A missing baseURL makes the origin "null", so every request counts as external.
  const origin = new URL(baseURL ?? "about:blank").origin;
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) external.push(request.url());
  });

  await page.goto("/");
  await expect(page).toHaveURL(/\/operar$/);
  await expect(page.getByRole("heading", { name: "Nueva entrada" })).toBeVisible();
  await expect(page.getByText("Selecciona el instrumento y revisa tu orden.")).toBeVisible();
  await expect(page.getByRole("banner").getByText("SIM")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Principal" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Operar" }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('500 16px "IBM Plex Mono"'))).toBe(true);
  expect(external).toEqual([]);
});

test("narrow viewport shows the mobile header and bottom nav, not the sidebar", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/operar");
  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "REEL CAPITAL" })).toBeVisible();
  await expect(header.getByText("SIM")).toBeVisible();
  const bottom = page.getByRole("navigation", { name: "Principal" }).last();
  await expect(bottom.getByRole("link", { name: "Operar" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("aside.sidebar")).toBeHidden();
});

test("preloads the main fonts and serves font files as immutable", async ({ request }) => {
  const page = await (await request.get("/acceso")).text();
  expect(page).toContain('href="/fonts/ibm-plex-mono-latin-400-normal.woff2"');
  expect(page).toContain('href="/fonts/ibm-plex-mono-latin-600-normal.woff2"');
  const font = await request.get("/fonts/ibm-plex-mono-latin-400-normal.woff2");
  expect(font.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
});
