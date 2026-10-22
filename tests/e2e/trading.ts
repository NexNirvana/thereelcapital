import { type Locator, type Page } from "@playwright/test";
import { expect } from "./test.ts";
import { SETTLE_MS } from "./support.ts";

// Steps the trading specs share, driven through the UI against the local simulation
// (tests/e2e/engine.env).

export async function openReview(page: Page, symbol: string) {
  await page.goto(`/operar?simbolo=${symbol}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /Revisar orden/ }).click();
  await expect(page).toHaveURL(/\/operar\/revisar\?/);
  await expect(page.getByRole("heading", { name: "Revisar orden" })).toBeVisible();
  // Let the page hydrate before submitting: a native post would reload it under the assertions.
  await page.waitForLoadState("networkidle");
}

/** Submits the review and waits until the browser is on the order's status page. */
export async function send(page: Page, button = "Enviar orden") {
  await page.getByRole("button", { name: button }).click();
  await expect(page).toHaveURL(/\/operar\/revisar\/[A-Za-z0-9_-]{22}$/, { timeout: SETTLE_MS });
}

/** Buys through the UI and waits for the engine to open the position. */
export async function openPosition(page: Page, symbol: string, shares: string) {
  await page.goto(`/operar?simbolo=${symbol}`);
  await page.getByRole("link", { name: /Revisar orden/ }).click();
  await page.getByRole("button", { name: "Enviar orden" }).click();
  await expect(page).toHaveURL(/\/operar\/revisar\/[A-Za-z0-9_-]{22}$/, { timeout: SETTLE_MS });
  // The position shows up on a poll. Wait for the page to hydrate too: a click before that is a
  // native form post that reloads the page under the assertions.
  await page.goto("/posiciones", { waitUntil: "networkidle" });
  // The page shows the first position's numbers, so with another one already open the symbol
  // (heading, or link in the position list) is what proves this one exists.
  await expect(
    page
      .getByRole("heading", { name: symbol })
      .or(page.getByRole("link", { name: symbol }))
      .first(),
  ).toBeVisible({ timeout: SETTLE_MS });
  await expect(page.getByText(`${shares} restantes`, { exact: true })).toBeVisible({
    timeout: SETTLE_MS,
  });
  await page.waitForLoadState("networkidle");
}

/** Clicks an exit button and waits for the server's answer, so nothing below races the request. */
export async function sell(page: Page, button: Locator) {
  const answered = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/salir"),
    { timeout: SETTLE_MS },
  );
  await button.click();
  await answered;
}

export const step = (page: Page, n: number) =>
  page.getByRole("button", { name: new RegExp(`^Paso ${n},`) });
