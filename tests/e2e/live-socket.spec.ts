import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { origin, seedTradingClient } from "./support.ts";

// The signed-in app keeps one live-price socket (D47): it opens with the app and the screens only
// change what they watch. The local simulation has no quote stream, so the socket answers
// `unavailable` and the prices come from the poll; what this spec checks is the socket's lifetime.

test.beforeEach(async ({ context }) => {
  const ip = `10.8.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: origin });
});

function watchSockets(page: Page) {
  const opened: number[] = [];
  const firstFrame: number[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/operar/en-vivo")) return;
    opened.push(Date.now());
    socket.on("framereceived", () => firstFrame.push(Date.now()));
  });
  return { opened, firstFrame };
}

test("navigating between screens reuses the one live socket", async ({ context, page }) => {
  await seedTradingClient(context);
  const sockets = watchSockets(page);
  await page.goto("/posiciones");
  await expect.poll(() => sockets.opened.length).toBe(1);

  const startedAt = Date.now();
  await page.getByRole("link", { name: "Operar" }).first().click();
  await expect(page.getByRole("heading", { name: "Nueva entrada" })).toBeVisible();
  await page.getByLabel("Símbolo").fill("msft");
  await page.getByRole("button", { name: "Consultar" }).click();
  await expect(page.locator(".form dl")).toContainText("US$101.00");
  const shownAfterMs = Date.now() - startedAt;
  const socketAfterMs = (sockets.firstFrame.find((at) => at >= startedAt) ?? NaN) - startedAt;
  // Recorded for the PR: sockets created by the whole walk, and the time to the first frame and to
  // the shown price after the navigation started.
  console.log(
    `live-socket: sockets=${sockets.opened.length} firstFrameAfterMs=${socketAfterMs} priceShownAfterMs=${shownAfterMs}`,
  );

  await page.getByRole("link", { name: "Posiciones" }).first().click();
  await expect(page.getByRole("heading", { name: "Posiciones" })).toBeVisible();
  await page.getByRole("link", { name: "Operar" }).first().click();
  await expect(page.getByRole("heading", { name: "Nueva entrada" })).toBeVisible();
  expect(sockets.opened.length).toBe(1);
});
