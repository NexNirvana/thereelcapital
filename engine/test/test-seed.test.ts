import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedForTest } from "../src/test-seed";

const insertAccount = [
  {
    sql: "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', ?, 'Margin')",
    params: ["SIM-1"],
  },
];
const accounts = (stub: ReturnType<typeof env.COORDINATOR.getByName>) =>
  runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT account_id FROM broker_accounts").toArray(),
  );

describe("seeding a Durable Object for tests", () => {
  it("is refused outside development and test, writing nothing", async () => {
    const stub = env.COORDINATOR.getByName("seed-refused");
    await runInDurableObject(stub, (_instance, state) => {
      for (const environment of ["production", undefined, ""]) {
        expect(seedForTest(environment, state.storage, insertAccount)).toEqual({
          ok: false,
          reason: "NOT_AVAILABLE",
        });
      }
    });
    expect(await accounts(stub)).toEqual([]);
  });

  it("is open through the RPC on the test configuration", async () => {
    const stub = env.COORDINATOR.getByName("seed-rpc");
    expect(await stub.seedForTest(insertAccount)).toEqual({ ok: true });
    expect(await accounts(stub)).toEqual([{ account_id: "SIM-1" }]);
  });

  it("writes the rows in development and test, and only valid statements", async () => {
    const stub = env.COORDINATOR.getByName("seed-allowed");
    await runInDurableObject(stub, (_instance, state) => {
      expect(seedForTest("test", state.storage, insertAccount)).toEqual({ ok: true });
      expect(seedForTest("test", state.storage, [{ sql: 1 }])).toEqual({
        ok: false,
        reason: "INVALID_INPUT",
      });
      expect(seedForTest(undefined, state.storage, insertAccount).ok).toBe(false);
    });
    expect(await accounts(stub)).toEqual([{ account_id: "SIM-1" }]);
  });
});
