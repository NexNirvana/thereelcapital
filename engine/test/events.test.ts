import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EVENT_RETENTION_MS } from "#lib/domain/config.ts";
import { pruneEvents, writeEvent } from "../src/events.ts";

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

  it("prunes only events older than the retention window", async () => {
    const stub = env.COORDINATOR.getByName("events-prune");
    await stub.ping();
    const now = EVENT_RETENTION_MS * 2;

    const kept = await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      for (const at of [1, now - EVENT_RETENTION_MS - 1, now - EVENT_RETENTION_MS, now]) {
        writeEvent(sql, at, { mode: "SIM", level: "info", type: "t", message: "m" });
      }
      pruneEvents(sql, now, "SIM");
      return sql.exec<{ at: number }>("SELECT at FROM events ORDER BY at").toArray();
    });
    expect(kept.map((row) => row.at)).toEqual([now - EVENT_RETENTION_MS, now]);
  });

  it("has the indexes the history and sync queries use", async () => {
    const stub = env.COORDINATOR.getByName("events-indexes");
    await stub.ping();
    const plan = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT at FROM events WHERE mode = 'SIM' AND at >= 1 ORDER BY at DESC, id DESC",
        )
        .toArray()
        .map((row) => row.detail)
        .join(" "),
    );
    expect(plan).toContain("events_by_mode_at");
  });

  it("uses the index to find the events to prune", async () => {
    const stub = env.COORDINATOR.getByName("events-prune-plan");
    await stub.ping();
    const plan = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN DELETE FROM events WHERE mode = 'SIM' AND at < 1",
        )
        .toArray()
        .map((row) => row.detail)
        .join(" "),
    );
    expect(plan).toContain("events_by_mode_at");
  });
});
