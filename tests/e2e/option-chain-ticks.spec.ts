import { expect, test } from "./test.ts";
import { type Page, type WebSocketRoute } from "@playwright/test";
import { seedTradingClient, origin } from "./support.ts";

// The local simulation has no quote stream, so the socket is played by the test: it says the stream
// is live and then pushes ticks, which the chain applies together once per animation frame.
test.beforeEach(async ({ context }) => {
  const ip = `10.8.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip, origin: origin });
});

async function openLiveChain(page: Page) {
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/operar\/en-vivo$/, (route) => {
    socket = route;
    route.onMessage(() => {});
  });
  await page.goto("/operar?tipo=opciones&subyacente=MSFT", { waitUntil: "networkidle" });
  await expect(page.getByRole("table")).toBeVisible();
  await expect.poll(() => socket !== null).toBe(true);
  const send = (message: object) => socket?.send(JSON.stringify(message));
  send({ type: "state", state: "live" });
  // The engine's heartbeat marks the feed as on the stream, so the fast fallback poll stands down.
  send({ type: "alive", receivedAt: Date.now() });
  return send;
}

const symbolOf = async (page: Page, name: RegExp) =>
  new URL(
    (await page.getByRole("link", { name }).getAttribute("href")) ?? "",
    origin,
  ).searchParams.get("simbolo");

test("applies a burst of ticks together: the last tick of a contract wins and other rows stay", async ({
  context,
  page,
}) => {
  await seedTradingClient(context);
  const send = await openLiveChain(page);
  const call400 = page.getByRole("link", { name: /^Elegir Call 400/ });
  const put400 = page.getByRole("link", { name: /^Elegir Put 400/ });
  const call = await symbolOf(page, /^Elegir Call 400/);
  const put = await symbolOf(page, /^Elegir Put 400/);
  const putBefore = await put400.innerText();
  const at = Date.now();
  for (const [bid, ask] of [
    [1_000_000, 1_100_000],
    [2_000_000, 2_100_000],
    [3_330_000, 3_440_000],
  ]) {
    send({ type: "quote", symbol: call, bid, ask, receivedAt: at });
  }
  await expect(call400).toContainText("3.33 / 3.44");
  await expect(put400).toHaveText(putBefore);
  // The contract loses its market: shown as missing, never as 0, and back when its quote returns.
  send({ type: "quote", symbol: call, bid: null, ask: null, receivedAt: at + 1 });
  await expect(page.getByRole("link", { name: /^Elegir Call 400/ })).toHaveCount(0);
  send({ type: "quote", symbol: call, bid: 4_000_000, ask: 4_100_000, receivedAt: at + 2 });
  await expect(call400).toContainText("4.00 / 4.10");
  send({ type: "quote", symbol: put, bid: 5_000_000, ask: 5_100_000, receivedAt: at + 3 });
  await expect(put400).toContainText("5.00 / 5.10");
});
