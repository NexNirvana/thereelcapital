import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const url = "https://engine.invalid/live";

describe("the live-price socket of the coordinator", () => {
  it("refuses a plain request", async () => {
    const response = await env.COORDINATOR.getByName("live-plain").fetch(url);
    expect(response.status).toBe(426);
  });

  it("accepts a socket and answers unavailable when the broker has no quote stream", async () => {
    const response = await env.COORDINATOR.getByName("live-sim").fetch(url, {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) throw new Error("no socket");
    socket.accept();
    const first = new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => resolve(String(event.data))),
    );
    socket.send(JSON.stringify({ type: "watch", symbols: ["AAPL"] }));
    expect(JSON.parse(await first)).toEqual({ type: "state", state: "unavailable" });
    socket.close();
  });

  it("closes a socket that sends something other than a watch", async () => {
    const response = await env.COORDINATOR.getByName("live-bad").fetch(url, {
      headers: { upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (socket === null) throw new Error("no socket");
    socket.accept();
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.send(JSON.stringify({ type: "buy", price: 1 }));
    expect(await closed).toBe(1008);
  });
});
