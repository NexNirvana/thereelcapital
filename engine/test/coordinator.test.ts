import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ClientCoordinator } from "../src/index";

describe("ClientCoordinator", () => {
  it("answers the ping RPC and keeps SQLite state", async () => {
    const stub = env.COORDINATOR.getByName("test-client");

    expect(await stub.ping()).toBe("pong");

    await runInDurableObject(stub, (instance: ClientCoordinator, state) => {
      expect(instance).toBeInstanceOf(ClientCoordinator);
      state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, note TEXT)",
      );
      state.storage.sql.exec("INSERT INTO probe (note) VALUES ('stored')");
    });

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT note FROM probe").toArray(),
    );
    expect(rows).toEqual([{ note: "stored" }]);
  });

  it("has D1 migrations applied before tests", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
    ).first();
    expect(row).not.toBeNull();
  });
});
