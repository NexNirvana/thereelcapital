import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { writeEvent } from "../src/events.ts";

describe("events writer", () => {
  it("stores the event with its mode and clock", async () => {
    const stub = env.COORDINATOR.getByName("events-basic");
    await stub.ping();

    const rows = await runInDurableObject(stub, (_i, state) => {
      writeEvent(state.storage.sql, 1_000, {
        mode: "SIM",
        level: "warn",
        type: "test.event",
        message: "hello",
        data: { symbol: "AAPL" },
      });
      return state.storage.sql
        .exec("SELECT at, mode, level, type, message, data_json FROM events")
        .toArray();
    });
    expect(rows).toEqual([
      {
        at: 1_000,
        mode: "SIM",
        level: "warn",
        type: "test.event",
        message: "hello",
        data_json: '{"symbol":"AAPL"}',
      },
    ]);
  });

  it("redacts credential-like keys, nested ones included", async () => {
    const stub = env.COORDINATOR.getByName("events-redact");
    await stub.ping();

    const row = await runInDurableObject(stub, (_i, state) => {
      writeEvent(state.storage.sql, 1, {
        mode: "SIM",
        level: "error",
        type: "test.secrets",
        message: "m",
        data: { refresh_token: "r-123", nested: { clientSecret: "s-456" }, symbol: "AAPL" },
      });
      return state.storage.sql.exec<{ data_json: string }>("SELECT data_json FROM events").one();
    });
    expect(row.data_json).not.toContain("r-123");
    expect(row.data_json).not.toContain("s-456");
    expect(JSON.parse(row.data_json)).toEqual({
      refresh_token: "[redacted]",
      nested: { clientSecret: "[redacted]" },
      symbol: "AAPL",
    });
  });
});
