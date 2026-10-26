import { expect, test } from "bun:test";
import { handOffLiveSocket } from "./live-handoff.ts";

const quiet = () => {};

test("answers 502 and logs the error name and message when the stub fetch throws", async () => {
  const logged: Array<[string, Record<string, unknown>]> = [];
  const result = await handOffLiveSocket(
    {
      fetch: () => {
        throw new TypeError("stub exploded");
      },
    },
    (message, detail) => logged.push([message, detail]),
  );
  expect(result).toEqual({ kind: "unavailable", status: 502 });
  expect(logged).toEqual([
    ["live.handoff failed", { name: "TypeError", message: "stub exploded" }],
  ]);
});

test("answers 503 and logs the status when the engine does not upgrade", async () => {
  const logged: Array<[string, Record<string, unknown>]> = [];
  const result = await handOffLiveSocket(
    { fetch: async () => new Response("no", { status: 409 }) },
    (message, detail) => logged.push([message, detail]),
  );
  expect(result).toEqual({ kind: "unavailable", status: 503 });
  expect(logged).toEqual([["live.handoff refused", { status: 409, webSocket: false }]]);
});

test("sends the engine a fresh upgrade request without the browser's headers", async () => {
  let seen: Request | undefined;
  await handOffLiveSocket(
    {
      fetch: async (request) => {
        seen = request;
        return new Response("no", { status: 426 });
      },
    },
    quiet,
  );
  expect(seen?.headers.get("upgrade")).toBe("websocket");
  expect(seen?.headers.get("cookie")).toBeNull();
});
