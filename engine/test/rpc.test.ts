import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const accountId = "SIM123";
const entryCalls = [
  ["prepareEntry", { mode: "SIM", accountId, symbol: "AAPL", assetType: "equity" }],
  [
    "sendEntry",
    {
      mode: "SIM",
      accountId,
      symbol: "AAPL",
      assetType: "equity",
      intentId: "A".repeat(22),
      confirmedQty: 1,
    },
  ],
] as const;
const calls = [
  ["exit", { mode: "SIM", positionId: "p-1", step: 0 }],
  ["exit", { mode: "SIM", positionId: "p-1", step: "ALL_OUT" }],
  ["cancel", { mode: "SIM", intentId: "i-1" }],
  ["activateTrailing", { mode: "SIM", positionId: "p-1", trailingPct: 10 }],
] as const;
const reads = [
  "state",
  "history",
  "connection",
  "sync",
  "optionExpirations",
  "optionChain",
  "optionContract",
  "beginConnection",
  "completeConnection",
  "disconnect",
] as const;
const allMethods = [
  ...entryCalls.map(([method]) => method),
  ...calls.map(([method]) => method),
  ...reads,
] as const;

function stubFor(name: string) {
  return env.COORDINATOR.getByName(name);
}

async function eventTypes(stub: ReturnType<typeof stubFor>) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec<{ mode: string; type: string }>("SELECT mode, type FROM events ORDER BY id")
      .toArray(),
  );
}

describe("ClientCoordinator RPC surface", () => {
  it.each([
    ["exit", { mode: "SIM", positionId: "p-1", step: 0 }],
    ["cancel", { mode: "SIM", intentId: "i-1" }],
    ["activateTrailing", { mode: "SIM", positionId: "p-1", trailingPct: 10 }],
  ] as const)("%s on a client that never connected is blocked, not sent", async (method, args) => {
    const result = await stubFor(`rpc-${method}`)[method](args);
    expect(result).toMatchObject({ ok: true, value: { status: "BLOCKED" } });
  });

  it.each([
    ...entryCalls.map(([method, args]) => [method, args] as const),
    ...calls.map(([method, args]) => [method, args] as const),
    ...reads.map((m) => [m, {}] as const),
  ])("%s rejects REAL before doing anything", async (method, args) => {
    const stub = stubFor(`real-${method}-${JSON.stringify(args)}`);
    const result = await stub[method]({ ...args, mode: "REAL" });
    expect(result).toMatchObject({ ok: false, code: "MODE_NOT_SIM" });
    expect(await eventTypes(stub)).toEqual([{ mode: "REAL", type: "rpc.mode_not_sim" }]);
  });

  it.each(allMethods)(
    "%s rejects REAL even when the rest of the input is invalid",
    async (method) => {
      const stub = stubFor(`real-bad-${method}`);
      for (const input of [
        { mode: "REAL" },
        { mode: "REAL", intentId: "" },
        { mode: "REAL", extra: 1 },
      ]) {
        expect(await stub[method](input)).toMatchObject({ ok: false, code: "MODE_NOT_SIM" });
      }
    },
  );

  it.each(allMethods)("%s rejects malformed input with INVALID_INPUT", async (method) => {
    const stub = stubFor(`bad-${method}`);
    for (const input of [undefined, null, "SIM", {}, { mode: "LIVE" }, { mode: "SIM", extra: 1 }]) {
      expect(await stub[method](input)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
  });

  it("rejects fields the browser must never supply", async () => {
    const stub = stubFor("untrusted-fields");
    const base = { mode: "SIM", accountId, symbol: "AAPL", assetType: "equity" };
    for (const extra of [
      { qty: 5 },
      { size: 50_000 },
      { price: 1 },
      { clientId: "other" },
      { url: "https://x" },
    ]) {
      expect(await stub.prepareEntry({ ...base, ...extra })).toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it("rejects out-of-range scale-out steps and trailing percentages", async () => {
    const stub = stubFor("ranges");
    expect(await stub.exit({ mode: "SIM", positionId: "p", step: 7 })).toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(
      await stub.activateTrailing({ mode: "SIM", positionId: "p", trailingPct: 3 }),
    ).toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("returns empty state, history and a disconnected broker on a new client", async () => {
    const stub = stubFor("empty-reads");
    expect(await stub.state({ mode: "SIM" })).toEqual({
      ok: true,
      value: { mode: "SIM", positions: [], activeIntents: [] },
    });
    expect(await stub.history({ mode: "SIM" })).toEqual({
      ok: true,
      value: { mode: "SIM", intents: [], events: [], accounts: [], nextCursor: null },
    });
    expect(await stub.connection({ mode: "SIM" })).toEqual({
      ok: true,
      value: { mode: "SIM", status: "NOT_CONNECTED" },
    });
  });

  it("logs rejections without echoing the input", async () => {
    const stub = stubFor("log-hygiene");
    await stub.sendEntry({ mode: "SIM", intentId: "i", refreshToken: "tok-secret-1" });
    const dump = await runInDurableObject(stub, (_i, state) =>
      JSON.stringify(state.storage.sql.exec("SELECT * FROM events").toArray()),
    );
    expect(dump).toContain("rpc.invalid_input");
    expect(dump).not.toContain("tok-secret-1");
  });

  it("never shows one client's data to another", async () => {
    const alice = stubFor("iso-alice");
    const bob = stubFor("iso-bob");
    await runInDurableObject(alice, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO intents (id, mode, kind, account_id, symbol, asset_type, trade_action, qty, state,
           order_confirm_id, created_at, updated_at)
         VALUES ('i-a', 'SIM', 'entry', 'SIM1', 'AAPL', 'equity', 'BUY', 3, 'ARMED', 'i-a', 1, 1)`,
      );
    });

    expect(await alice.state({ mode: "SIM" })).toMatchObject({
      value: { activeIntents: [{ id: "i-a" }] },
    });
    expect(await alice.history({ mode: "SIM" })).toMatchObject({
      value: { intents: [{ id: "i-a" }] },
    });
    expect(await bob.state({ mode: "SIM" })).toMatchObject({
      value: { positions: [], activeIntents: [] },
    });
    expect(await bob.history({ mode: "SIM" })).toMatchObject({ value: { intents: [] } });
  });
});
