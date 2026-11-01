// REAL orders behind the four locks (D52), without any money: the REAL broker is a local simulation
// or the TradeStation adapter over a scripted fetch, and the engine test setup refuses any
// unscripted request to the live origin.
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { BrokerAdapterShape } from "../src/broker/adapter.ts";
import { makeLocalSim, type LocalSim } from "../src/broker/local-sim/sim.ts";
import { entryLimits, prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { exitPosition } from "../src/exits.ts";
import { recordModeLocks } from "../src/mode.ts";
import { listRealAccounts } from "../src/real-accounts.ts";
import { runSync } from "../src/sync.ts";
import { makeTradeStationAdapter } from "../src/tradestation/adapter.ts";
import { LIVE_API_BASE_URL } from "../src/tradestation/endpoints.ts";
import type { FetchFn } from "../src/tradestation/http.ts";
import accountsFixture from "./fixtures/accounts.json";
import placeFixture from "./fixtures/place.json";
import quotesFixture from "./fixtures/quotes.json";
import symbolEquity from "./fixtures/symbol-details-equity.json";
import { json, okToken } from "./tradestation/helpers.ts";
import {
  IN_SESSION,
  inClient,
  newClient,
  newSim,
  usd,
  type Client,
  type Clock,
} from "./sync-helpers.ts";

const OPEN = { deploymentOpen: true, clientEnabled: true };
const FLAG_OFF = { deploymentOpen: true, clientEnabled: false };
const CLOSED = { deploymentOpen: false, clientEnabled: true };

let n = 0;
const uniqueAccount = (name: string) => `${name}-${++n}-${crypto.randomUUID().slice(0, 8)}`;

const target = (accountId: string, symbol = "AAPL") =>
  ({ mode: "REAL", accountId, symbol, assetType: "equity" }) as const;

/** The live host's simulation: its own account and its own prices, apart from SIM's. */
function newRealSim(clock: Clock, accountId: string, ask = 250): LocalSim {
  return makeLocalSim({
    now: () => clock.now,
    seed: "real-orders",
    accounts: [{ accountId }],
    symbols: ["AAPL", "MSFT", "NVDA"].map((symbol) => ({
      symbol,
      assetType: "equity" as const,
      bid: usd(ask - 1),
      ask: usd(ask),
    })),
  });
}

/** Runs `body` with a SIM context and a REAL one that share the Durable Object's storage. */
async function inBothModes<T>(
  clock: Clock,
  options: {
    locks?: { deploymentOpen: boolean; clientEnabled: boolean };
    realSim?: LocalSim;
    account?: string;
    client?: Client;
  },
  body: (t: {
    sim: ReturnType<typeof newSim>;
    simCtx: EntryContext;
    realSim: LocalSim;
    realCtx: EntryContext;
    account: string;
    state: DurableObjectState;
  }) => Promise<T>,
): Promise<T> {
  const account = options.account ?? uniqueAccount("LIVE");
  const sim = newSim(clock);
  sim.setFill({ kind: "instant" });
  const realSim = options.realSim ?? newRealSim(clock, account);
  realSim.setFill({ kind: "instant" });
  const client = options.client ?? (await newClient());
  return inClient(client, clock, sim.adapter, async (simCtx, state) => {
    recordModeLocks(state.storage, options.locks ?? OPEN);
    simCtx.sql.exec(
      "INSERT OR IGNORE INTO broker_accounts (mode, account_id, account_type) VALUES ('REAL', ?, 'Margin')",
      account,
    );
    const realCtx: EntryContext = { ...simCtx, mode: "REAL", broker: realSim.adapter };
    return body({ sim, simCtx, realSim, realCtx, account, state });
  });
}

async function enter(ctx: EntryContext, accountId: string, symbol = "AAPL") {
  const request = { ...target(accountId, symbol), mode: ctx.mode };
  const prepared = await prepareEntry(ctx, request);
  if (!prepared.ok || prepared.value.status !== "READY") return prepared;
  return sendEntry(ctx, {
    ...request,
    intentId: prepared.value.intentId,
    confirmedQty: prepared.value.qty,
  });
}

const ordersOf = (sim: { adapter: BrokerAdapterShape }, accounts: string[]) =>
  Effect.runPromise(sim.adapter.orders(accounts));
const rowCount = (ctx: EntryContext, sql: string) => ctx.sql.exec<{ n: number }>(sql).one().n;

describe("REAL entries and the locks", () => {
  it.each([
    ["the deployment switch is closed", CLOSED],
    ["the client flag is off", FLAG_OFF],
  ])("refuses a REAL entry when %s, and persists and places nothing", async (_name, locks) => {
    const clock: Clock = { now: IN_SESSION };
    await inBothModes(clock, { locks }, async ({ realCtx, realSim, account }) => {
      expect(await prepareEntry(realCtx, target(account))).toMatchObject({
        value: { status: "BLOCKED", reasons: ["MODE_NOT_ENABLED"] },
      });
      expect(await enter(realCtx, account)).toMatchObject({ ok: true });
      expect(await enter(realCtx, account)).not.toMatchObject({
        value: { status: "PLACED" },
      });
      expect(rowCount(realCtx, "SELECT COUNT(*) AS n FROM intents")).toBe(0);
      expect(rowCount(realCtx, "SELECT COUNT(*) AS n FROM entry_counters")).toBe(0);
      expect(await ordersOf(realSim, [account])).toEqual([]);
    });
  });

  it("refuses an account that only SIM lists: it is not stored for REAL", async () => {
    const clock: Clock = { now: IN_SESSION };
    await inBothModes(clock, {}, async ({ realCtx, realSim, account }) => {
      expect(await enter(realCtx, "SIM-1")).toMatchObject({
        value: { status: "BLOCKED", reasons: ["ACCOUNT_NOT_OWNED"] },
      });
      expect(await ordersOf(realSim, [account])).toEqual([]);
    });
  });

  it("refuses an account bound to another client", async () => {
    const clock: Clock = { now: IN_SESSION };
    const shared = uniqueAccount("BOUND");
    const sim = newRealSim(clock, shared);
    const [first, second] = [await newClient(), await newClient()];
    await inBothModes(clock, { client: first, account: shared, realSim: sim }, ({ realCtx }) =>
      listRealAccounts(realCtx, sim.adapter),
    );
    await inBothModes(clock, { client: second, account: "UNUSED", realSim: sim }, async (t) => {
      // The second client's listing skips the bound account, so it has no REAL row for it.
      await listRealAccounts(t.realCtx, sim.adapter);
      t.realCtx.sql.exec(
        "DELETE FROM broker_accounts WHERE mode = 'REAL' AND account_id = 'UNUSED'",
      );
      expect(await enter(t.realCtx, shared)).toMatchObject({
        value: { status: "BLOCKED", reasons: ["ACCOUNT_NOT_OWNED"] },
      });
      expect(await ordersOf(sim, [shared])).toEqual([]);
    });
  });

  it("accepts a REAL entry with every lock open, sized from the REAL ask and persisted before the broker call", async () => {
    const clock: Clock = { now: IN_SESSION };
    const seen: Array<{ state: string; mode: string }> = [];
    await inBothModes(clock, {}, async ({ sim, realSim, realCtx, account }) => {
      const place = realSim.adapter.placeOrder;
      const spied: BrokerAdapterShape = {
        ...realSim.adapter,
        placeOrder: (request) => {
          seen.push(
            realCtx.sql
              .exec<{ state: string; mode: string }>(
                "SELECT state, mode FROM intents WHERE order_confirm_id = ?",
                request.orderConfirmId,
              )
              .one(),
          );
          return place(request);
        },
      };
      const sent = await enter({ ...realCtx, broker: spied }, account);
      // SIZE 20,000 over the REAL ask 250 is 80; SIM's ask of 200 would have given 100.
      expect(sent).toMatchObject({ value: { status: "PLACED", qty: 80 } });
      expect(seen).toEqual([{ state: "SENT", mode: "REAL" }]);
      expect(await ordersOf(realSim, [account])).toHaveLength(1);
      expect(await ordersOf(sim, ["SIM-1", "SIM-2"])).toEqual([]);
    });
  });
});

describe("REAL entries through the TradeStation adapter with a scripted live host", () => {
  const LIVE_ACCOUNT = accountsFixture.Accounts[0]?.AccountID ?? "";

  function scripted(listed: string[]) {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const fetchFn: FetchFn = (url, init) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? init.body : null,
      });
      const path = new URL(url).pathname;
      if (path.endsWith("/brokerage/accounts")) {
        return Promise.resolve(
          json({
            Accounts: listed.map((id) => ({
              AccountID: id,
              AccountType: "Margin",
              Status: "Active",
            })),
          }),
        );
      }
      if (path.includes("/marketdata/symbols/")) return Promise.resolve(json(symbolEquity));
      if (path.includes("/marketdata/quotes")) return Promise.resolve(json(quotesFixture));
      if (path.endsWith("/orderexecution/orders")) return Promise.resolve(json(placeFixture));
      return Promise.resolve(json({}, 404));
    };
    const made = makeTradeStationAdapter({
      mode: "REAL",
      realTrading: true,
      accessToken: okToken,
      fetch: fetchFn,
      retryDelayMs: 0,
      now: () => IN_SESSION,
    });
    if (!made.ok) throw new Error(made.reason);
    return { adapter: made.adapter, calls };
  }

  const orderPosts = (calls: Array<{ url: string; method: string; body: string | null }>) =>
    calls.filter((call) => call.method === "POST");

  it("places one order on the live base after the intent is SENT, sized from the live ask", async () => {
    const clock: Clock = { now: IN_SESSION };
    const live = scripted([LIVE_ACCOUNT]);
    await inBothModes(clock, { account: LIVE_ACCOUNT }, async ({ realCtx }) => {
      const stateAtPost: string[] = [];
      const inspect: BrokerAdapterShape = {
        ...live.adapter,
        placeOrder: (request) => {
          stateAtPost.push(
            realCtx.sql
              .exec<{ state: string }>(
                "SELECT state FROM intents WHERE id = ?",
                request.orderConfirmId,
              )
              .one().state,
          );
          return live.adapter.placeOrder(request);
        },
      };
      const sent = await enter({ ...realCtx, broker: inspect }, LIVE_ACCOUNT, "MSFT");
      expect(sent).toMatchObject({ value: { status: "PLACED" } });
      expect(stateAtPost).toEqual(["SENT"]);
      expect(orderPosts(live.calls)).toHaveLength(1);
      expect(live.calls.every((call) => call.url.startsWith(LIVE_API_BASE_URL))).toBe(true);
      // The quantity is the client's SIZE (20,000) over the ask the live host quoted (212.87).
      expect(JSON.parse(orderPosts(live.calls)[0]?.body ?? "null")).toMatchObject({
        Quantity: "93",
        AccountID: LIVE_ACCOUNT,
      });
    });
  });

  it("sends no order for an account the live host did not list, even if it is stored for REAL", async () => {
    const clock: Clock = { now: IN_SESSION };
    const live = scripted(["SOMEONE-ELSE"]);
    await inBothModes(clock, { account: LIVE_ACCOUNT }, async ({ realCtx }) => {
      const sent = await enter({ ...realCtx, broker: live.adapter }, LIVE_ACCOUNT, "MSFT");
      expect(sent).toMatchObject({ ok: true });
      expect(orderPosts(live.calls)).toEqual([]);
      expect(
        realCtx.sql.exec<{ state: string }>("SELECT state FROM intents").toArray(),
      ).not.toContainEqual({ state: "ACKNOWLEDGED" });
    });
  });
});

describe("REAL exits", () => {
  it("lets a REAL position be closed after the client flag is turned off", async () => {
    const clock: Clock = { now: IN_SESSION };
    await inBothModes(clock, {}, async ({ state, realCtx, realSim, account }) => {
      expect(await enter(realCtx, account)).toMatchObject({ value: { status: "PLACED" } });
      await runSync(realCtx);
      const position = realCtx.sql
        .exec<{ id: string }>("SELECT id FROM positions WHERE mode = 'REAL'")
        .one();
      recordModeLocks(state.storage, FLAG_OFF);
      // New entries are refused, the exit is not.
      expect(await enter(realCtx, account, "MSFT")).toMatchObject({
        value: { status: "BLOCKED", reasons: ["MODE_NOT_ENABLED"] },
      });
      const exit = await exitPosition(realCtx, {
        mode: "REAL",
        positionId: position.id,
        step: "ALL_OUT",
      });
      expect(exit).toMatchObject({ ok: true, value: { status: "PLACED" } });
      expect(await ordersOf(realSim, [account])).toHaveLength(2);
    });
  });

  it("refuses a REAL exit once the deployment switch closes", async () => {
    const clock: Clock = { now: IN_SESSION };
    await inBothModes(clock, {}, async ({ state, realCtx, account }) => {
      await enter(realCtx, account);
      await runSync(realCtx);
      const position = realCtx.sql
        .exec<{ id: string }>("SELECT id FROM positions WHERE mode = 'REAL'")
        .one();
      recordModeLocks(state.storage, CLOSED);
      expect(
        await exitPosition(realCtx, { mode: "REAL", positionId: position.id, step: "ALL_OUT" }),
      ).toMatchObject({ value: { status: "BLOCKED", reasons: ["MODE_NOT_ENABLED"] } });
    });
  });
});

describe("limits per mode", () => {
  it("gives SIM and REAL their own two open positions", async () => {
    const clock: Clock = { now: IN_SESSION };
    await inBothModes(clock, {}, async ({ simCtx, realCtx, account }) => {
      for (const symbol of ["AAPL", "MSFT"]) {
        expect(await enter(simCtx, "SIM-1", symbol)).toMatchObject({ value: { status: "PLACED" } });
      }
      await runSync(simCtx);
      expect(await prepareEntry(simCtx, { ...target("SIM-1", "NVDA"), mode: "SIM" })).toMatchObject(
        {
          value: { status: "BLOCKED", reasons: ["OPEN_POSITION_LIMIT"] },
        },
      );
      expect(await enter(realCtx, account)).toMatchObject({ value: { status: "PLACED" } });
      expect(entryLimits(realCtx, 3)).toMatchObject({ positions: 1, entriesToday: 1 });
      expect(entryLimits(simCtx, 3)).toMatchObject({ positions: 2, entriesToday: 2 });
    });
  });

  it("counts the daily entries of each mode apart", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    await env.DB.prepare("UPDATE client_settings SET max_daily_entries = 1 WHERE user_id = ?")
      .bind(client.userId)
      .run();
    await inBothModes(clock, { client }, async ({ simCtx, realCtx, account }) => {
      expect(await enter(simCtx, "SIM-1")).toMatchObject({ value: { status: "PLACED" } });
      expect(await prepareEntry(simCtx, { ...target("SIM-1", "MSFT"), mode: "SIM" })).toMatchObject(
        {
          value: { status: "BLOCKED", reasons: ["DAILY_ENTRY_LIMIT"] },
        },
      );
      expect(await enter(realCtx, account)).toMatchObject({ value: { status: "PLACED" } });
      expect(await prepareEntry(realCtx, target(account, "MSFT"))).toMatchObject({
        value: { status: "BLOCKED", reasons: ["DAILY_ENTRY_LIMIT"] },
      });
      expect(
        realCtx.sql
          .exec("SELECT mode, consumed, reserved FROM entry_counters ORDER BY mode")
          .toArray(),
      ).toEqual([
        { mode: "REAL", consumed: 0, reserved: 1 },
        { mode: "SIM", consumed: 0, reserved: 1 },
      ]);
    });
  });
});

describe("an unknown REAL placement", () => {
  it("is UNKNOWN, keeps its reservation, and is reconciled against the REAL broker", async () => {
    const clock: Clock = { now: IN_SESSION };
    await inBothModes(clock, {}, async ({ sim, simCtx, realSim, realCtx, account }) => {
      realSim.inject({ kind: "dropPlaceResponse" });
      const sent = await enter(realCtx, account);
      expect(sent).toMatchObject({ value: { status: "PLACED", state: "UNKNOWN" } });
      const intentId = realCtx.sql
        .exec<{ id: string }>("SELECT id FROM intents WHERE mode = 'REAL'")
        .one().id;
      expect(realCtx.sql.exec("SELECT mode, reserved FROM entry_counters").toArray()).toEqual([
        { mode: "REAL", reserved: 1 },
      ]);

      // The SIM pass knows nothing of the order and leaves the REAL intent alone.
      await runSync(simCtx);
      expect(realCtx.sql.exec("SELECT state FROM intents WHERE id = ?", intentId).one()).toEqual({
        state: "UNKNOWN",
      });

      await runSync(realCtx);
      expect(
        realCtx.sql.exec("SELECT state, filled_qty FROM intents WHERE id = ?", intentId).one(),
      ).toMatchObject({ state: "FILLED", filled_qty: 80 });
      // Found by its OrderConfirmID: no second order, and nothing reached SIM.
      expect(await ordersOf(realSim, [account])).toHaveLength(1);
      expect(await ordersOf(sim, ["SIM-1", "SIM-2"])).toEqual([]);
    });
  });
});

describe("a SIM entry and a REAL entry at the same time", () => {
  it("both go through, each with its own counters, rows and broker", async () => {
    const clock: Clock = { now: IN_SESSION };
    await inBothModes(clock, {}, async ({ sim, simCtx, realSim, realCtx, account }) => {
      const [simResult, realResult] = await Promise.all([
        enter(simCtx, "SIM-1"),
        enter(realCtx, account),
      ]);
      expect(simResult).toMatchObject({ value: { status: "PLACED", qty: 100 } });
      expect(realResult).toMatchObject({ value: { status: "PLACED", qty: 80 } });
      expect(
        simCtx.sql
          .exec("SELECT mode, consumed, reserved FROM entry_counters ORDER BY mode")
          .toArray(),
      ).toEqual([
        { mode: "REAL", consumed: 0, reserved: 1 },
        { mode: "SIM", consumed: 0, reserved: 1 },
      ]);
      expect(
        simCtx.sql.exec("SELECT mode, account_id FROM intents ORDER BY mode").toArray(),
      ).toEqual([
        { mode: "REAL", account_id: account },
        { mode: "SIM", account_id: "SIM-1" },
      ]);
      expect(await ordersOf(sim, ["SIM-1"])).toHaveLength(1);
      expect(await ordersOf(realSim, [account])).toHaveLength(1);
    });
  });
});
