import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localSimFor } from "../src/broker/provider.ts";
import { makeLocalSim, type LocalSim } from "../src/broker/local-sim/sim.ts";
import type { BrokerAdapterShape } from "../src/broker/adapter.ts";
import { createCipher } from "../src/crypto.ts";
import { entryLimits, prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { holdForReconciliation, TokenRefresher } from "../src/refresh.ts";
import { makeTradeStationAdapter } from "../src/tradestation/adapter.ts";
import accountsFixture from "./fixtures/accounts.json";
import { json, okToken, scriptedFetch } from "./tradestation/helpers.ts";

// Wednesday 2026-11-04 10:00 in New York: inside the regular session of NYSE and CBOE options.
const IN_SESSION = Date.UTC(2026, 10, 4, 15, 0, 0);
const SATURDAY = Date.UTC(2026, 10, 7, 15, 0, 0);
const usd = (dollars: number) => dollars * 1_000_000;

const SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA"] as const;

function newSim(now: () => number = () => IN_SESSION): LocalSim {
  return makeLocalSim({
    now,
    seed: "entries",
    accounts: [{ accountId: "SIM-1" }, { accountId: "SIM-2" }],
    symbols: [
      ...SYMBOLS.map((symbol) => ({
        symbol,
        assetType: "equity" as const,
        bid: usd(199),
        ask: usd(200),
      })),
      {
        symbol: "MSFT 261120C400",
        assetType: "option",
        bid: usd(3.9),
        ask: usd(4),
        option: { underlying: "MSFT", expiration: "2026-11-20", strike: usd(400), right: "call" },
      },
    ],
  });
}

let counter = 0;

/** A connected client with SIZE $20,000 and two SIM accounts, and the Durable Object that serves it. */
async function newClient(options: { sizeUsd?: number | null } = {}) {
  const userId = `entries-user-${++counter}`;
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Test', ?, 1, 0, 0)`,
  )
    .bind(userId, `${userId}@example.test`)
    .run();
  if (options.sizeUsd !== null) {
    await env.DB.prepare(
      "INSERT INTO client_settings (user_id, size_usd, stop_pct, trailing_unlock_pct, updated_at) VALUES (?, ?, 30, 70, 0)",
    )
      .bind(userId, options.sizeUsd ?? 20_000)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO broker_connection
       (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
     VALUES (?, 'ts-client-id', 'x', 'x', 'k', NULL, 'CONNECTED', 0)`,
  )
    .bind(userId)
    .run();
  const stub = env.COORDINATOR.getByName(userId);
  await stub.ping();
  await runInDurableObject(stub, (_i, state) => {
    for (const accountId of ["SIM-1", "SIM-2"]) {
      state.storage.sql.exec(
        "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', ?, 'Margin')",
        accountId,
      );
    }
  });
  return { userId, stub };
}

type Run<T> = (ctx: EntryContext, state: DurableObjectState, sim: LocalSim) => Promise<T> | T;

/** Runs `body` inside the client's Durable Object with an entry context over a local simulation. */
async function inClient<T>(
  client: Awaited<ReturnType<typeof newClient>>,
  body: Run<T>,
  options: { sim?: LocalSim; broker?: BrokerAdapterShape; now?: number } = {},
): Promise<T> {
  const sim = options.sim ?? newSim();
  return runInDurableObject(client.stub, async (_instance, state) => {
    const now = options.now ?? IN_SESSION;
    const tokens = new TokenRefresher({
      sql: state.storage.sql,
      storage: state.storage,
      db: env.DB,
      userId: client.userId,
      cipher: () => createCipher(env.CREDENTIALS_KEY),
      clock: () => now,
      retryDelayMs: 0,
    });
    const ctx: EntryContext = {
      sql: state.storage.sql,
      storage: state.storage,
      db: env.DB,
      userId: client.userId,
      now,
      cipher: () => createCipher(env.CREDENTIALS_KEY),
      tokens,
      broker: options.broker ?? sim.adapter,
    };
    return body(ctx, state, sim);
  });
}

const target = (symbol: string, accountId = "SIM-1", assetType: "equity" | "option" = "equity") =>
  ({ mode: "SIM", accountId, symbol, assetType }) as const;

async function send(
  ctx: EntryContext,
  symbol: string,
  options: { accountId?: string; assetType?: "equity" | "option"; confirmedQty?: number } = {},
) {
  const base = target(symbol, options.accountId, options.assetType);
  const prepared = await prepareEntry(ctx, base);
  if (!prepared.ok || prepared.value.status !== "READY") return prepared;
  return sendEntry(ctx, {
    ...base,
    intentId: prepared.value.intentId,
    confirmedQty: options.confirmedQty ?? prepared.value.qty,
  });
}

function snapshot(state: DurableObjectState) {
  const sql = state.storage.sql;
  return {
    counters: sql
      .exec("SELECT consumed, reserved FROM entry_counters WHERE mode = 'SIM'")
      .toArray(),
    intents: sql
      .exec<{ id: string; symbol: string; state: string }>(
        "SELECT id, symbol, state FROM intents ORDER BY created_at, symbol",
      )
      .toArray(),
  };
}

const orderCount = async (sim: LocalSim) => {
  const { Effect } = await import("effect");
  return (await Effect.runPromise(sim.adapter.orders(["SIM-1", "SIM-2"]))).length;
};

afterEach(() => vi.useRealTimers());

describe("prepareEntry", () => {
  it("sizes the quantity from the client's SIZE and the broker ask, and creates nothing", async () => {
    const client = await newClient();
    const { result, rows } = await inClient(client, async (ctx, state) => ({
      result: await prepareEntry(ctx, target("AAPL")),
      rows: snapshot(state),
    }));
    expect(result).toMatchObject({
      ok: true,
      value: { status: "READY", qty: 100, sizeMicros: usd(20_000), askMicros: usd(200) },
    });
    expect(rows).toEqual({ counters: [], intents: [] });
  });

  it("sizes options by the point value", async () => {
    const client = await newClient();
    const result = await inClient(client, (ctx) =>
      prepareEntry(ctx, target("MSFT 261120C400", "SIM-1", "option")),
    );
    // 20,000 / (4.00 × 100) = 50 contracts.
    expect(result).toMatchObject({
      ok: true,
      value: { status: "READY", qty: 50, pointValue: 100 },
    });
  });

  it("follows the SIZE stored for the client, not anything the browser sends", async () => {
    const client = await newClient({ sizeUsd: 40_000 });
    const result = await inClient(client, (ctx) => prepareEntry(ctx, target("AAPL")));
    expect(result).toMatchObject({ ok: true, value: { qty: 200 } });
  });

  it("reports why an entry is blocked", async () => {
    const noSize = await newClient({ sizeUsd: null });
    expect(await inClient(noSize, (ctx) => prepareEntry(ctx, target("AAPL")))).toMatchObject({
      ok: true,
      value: { status: "BLOCKED", reasons: ["SIZE_UNAVAILABLE"] },
    });

    const client = await newClient();
    const sim = newSim();
    sim.inject({ kind: "quoteStale", symbol: "AAPL" });
    expect(
      await inClient(client, (ctx) => prepareEntry(ctx, target("AAPL")), { sim }),
    ).toMatchObject({
      value: { status: "BLOCKED", reasons: ["QUOTE_STALE"] },
    });
    expect(await inClient(client, (ctx) => prepareEntry(ctx, target("NOPE")))).toMatchObject({
      value: { status: "BLOCKED", reasons: ["SYMBOL_DETAILS_MISSING"] },
    });
    expect(
      await inClient(client, (ctx) => prepareEntry(ctx, target("AAPL", "SIM-9"))),
    ).toMatchObject({ value: { status: "BLOCKED", reasons: ["ACCOUNT_NOT_OWNED"] } });
    expect(
      await inClient(client, (ctx) => prepareEntry(ctx, target("AAPL", "SIM-1", "option"))),
    ).toMatchObject({ value: { status: "BLOCKED", reasons: ["INSTRUMENT_OUT_OF_SCOPE"] } });
  });

  it("refuses outside the regular session", async () => {
    const client = await newClient();
    const result = await inClient(client, (ctx) => prepareEntry(ctx, target("AAPL")), {
      now: SATURDAY,
    });
    expect(result).toMatchObject({
      value: { status: "BLOCKED", reasons: ["OUTSIDE_REGULAR_SESSION"] },
    });
  });
});

describe("sendEntry", () => {
  it("reserves, persists the intent with its sizing, and places one MARKET order", async () => {
    const client = await newClient();
    const { sent, rows, intent, orders } = await inClient(client, async (ctx, state, sim) => {
      const sent = await send(ctx, "AAPL");
      return {
        sent,
        rows: snapshot(state),
        intent: state.storage.sql
          .exec(
            `SELECT kind, trade_action, qty, size_applied, point_value, quote_json, order_confirm_id,
                    broker_order_id, id FROM intents`,
          )
          .one(),
        orders: await orderCount(sim),
      };
    });
    expect(sent).toMatchObject({
      ok: true,
      value: { status: "PLACED", state: "ACKNOWLEDGED", qty: 100 },
    });
    expect(rows.counters).toEqual([{ consumed: 0, reserved: 1 }]);
    expect(intent).toMatchObject({
      kind: "entry",
      trade_action: "BUY",
      qty: 100,
      size_applied: usd(20_000),
      point_value: 1,
    });
    expect(intent["order_confirm_id"]).toBe(intent["id"]);
    expect(String(intent["id"])).toHaveLength(22);
    expect(JSON.parse(String(intent["quote_json"]))).toMatchObject({
      ask: usd(200),
      bid: usd(199),
    });
    expect(intent["broker_order_id"]).not.toBeNull();
    expect(orders).toBe(1);
  });

  it("stores the point value of an option on the intent", async () => {
    const client = await newClient();
    const row = await inClient(client, async (ctx, state) => {
      await send(ctx, "MSFT 261120C400", { assetType: "option" });
      return state.storage.sql.exec("SELECT trade_action, qty, point_value FROM intents").one();
    });
    expect(row).toEqual({ trade_action: "BUYTOOPEN", qty: 50, point_value: 100 });
  });

  it("sends the same intent twice as one broker order", async () => {
    const client = await newClient();
    const { first, second, third, orders, rows } = await inClient(
      client,
      async (ctx, state, sim) => {
        const prepared = await prepareEntry(ctx, target("AAPL"));
        if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
        const args = {
          ...target("AAPL"),
          intentId: prepared.value.intentId,
          confirmedQty: prepared.value.qty,
        };
        const [first, second] = await Promise.all([sendEntry(ctx, args), sendEntry(ctx, args)]);
        const third = await sendEntry(ctx, args);
        return { first, second, third, orders: await orderCount(sim), rows: snapshot(state) };
      },
    );
    const results = [first, second, third].map((r) => (r.ok ? r.value : null));
    expect(results.filter((r) => r?.status === "PLACED" && !r.replay)).toHaveLength(1);
    expect(results.filter((r) => r?.status === "PLACED" && r.replay)).toHaveLength(2);
    expect(orders).toBe(1);
    expect(rows.counters).toEqual([{ consumed: 0, reserved: 1 }]);
    expect(rows.intents).toHaveLength(1);
  });

  it("refuses to reuse an intent id for another instrument", async () => {
    const client = await newClient();
    const reused = await inClient(client, async (ctx, state) => {
      await send(ctx, "AAPL");
      const id = state.storage.sql.exec<{ id: string }>("SELECT id FROM intents").one().id;
      return sendEntry(ctx, { ...target("MSFT"), intentId: id, confirmedQty: 100 });
    });
    expect(reused).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("asks to re-confirm, reserving nothing, when the quantity moved", async () => {
    const client = await newClient();
    const { result, rows, orders } = await inClient(client, async (ctx, state, sim) => {
      const prepared = await prepareEntry(ctx, target("AAPL"));
      if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
      // The ask rises from 200 to 250 between prepare and send: 80 shares now, not 100.
      sim.setQuote("AAPL", { ask: usd(250) });
      const result = await sendEntry(ctx, {
        ...target("AAPL"),
        intentId: prepared.value.intentId,
        confirmedQty: prepared.value.qty,
      });
      return { result, rows: snapshot(state), orders: await orderCount(sim) };
    });
    expect(result).toMatchObject({
      ok: true,
      value: { status: "RECONFIRM", preview: { qty: 80, askMicros: usd(250) } },
    });
    expect(rows).toEqual({ counters: [], intents: [] });
    expect(orders).toBe(0);
  });

  it("uses the server's quantity, whatever the client confirmed", async () => {
    const client = await newClient();
    const { result, orders } = await inClient(client, async (ctx, _state, sim) => ({
      result: await send(ctx, "AAPL", { confirmedQty: 100_000 }),
      orders: await orderCount(sim),
    }));
    expect(result).toMatchObject({ value: { status: "RECONFIRM", preview: { qty: 100 } } });
    expect(orders).toBe(0);
  });

  it("reserves exactly the daily and slot allowance when entries race", async () => {
    const client = await newClient();
    const { first, second, rows, orders } = await inClient(client, async (ctx, state, sim) => {
      // Four entries across two accounts at once: only two slots exist.
      const first = await Promise.all(
        SYMBOLS.map((symbol, index) =>
          send(ctx, symbol, { accountId: index % 2 === 0 ? "SIM-1" : "SIM-2" }),
        ),
      );
      // Both positions fill and close: the slots are free again, and 2 of 3 entries are consumed.
      // A filled entry has its position (closed here), which is what stops it holding a slot.
      state.storage.sql.exec(
        "UPDATE intents SET state = 'FILLED', filled_qty = qty, position_id = 'closed-' || id WHERE state = 'ACKNOWLEDGED'",
      );
      state.storage.sql.exec("UPDATE entry_counters SET consumed = reserved, reserved = 0");
      const second = await Promise.all(
        SYMBOLS.map((symbol, index) =>
          send(ctx, symbol, { accountId: index % 2 === 0 ? "SIM-1" : "SIM-2" }),
        ),
      );
      return { first, second, rows: snapshot(state), orders: await orderCount(sim) };
    });
    const statuses = (results: typeof first) =>
      results.map((r) => (r.ok && "status" in r.value ? r.value.status : "?"));
    expect(statuses(first).sort()).toEqual(["BLOCKED", "BLOCKED", "PLACED", "PLACED"]);
    // Four racers, but the daily limit leaves one entry of three.
    expect(statuses(second).filter((s) => s === "PLACED")).toHaveLength(1);
    expect(rows.counters).toEqual([{ consumed: 2, reserved: 1 }]);
    expect(orders).toBe(3);
  });

  it("refuses a third slot while two entries are pending or two positions are open", async () => {
    const client = await newClient();
    const pending = await inClient(client, async (ctx) => {
      await send(ctx, "AAPL");
      await send(ctx, "MSFT");
      return send(ctx, "NVDA");
    });
    expect(pending).toMatchObject({
      value: { status: "BLOCKED", reasons: ["OPEN_POSITION_LIMIT"] },
    });

    const other = await newClient();
    const open = await inClient(other, async (ctx, state) => {
      for (const symbol of ["AAPL", "MSFT"]) {
        state.storage.sql.exec(
          `INSERT INTO positions (id, mode, account_id, symbol, original_qty, avg_entry_price, stop_pct,
             trailing_unlock_pct, protection_state, status, opened_on)
           VALUES (?, 'SIM', 'SIM-1', ?, 10, 1000000, 30, 70, 'server', 'OPEN', '2026-11-04')`,
          `pos-${symbol}`,
          symbol,
        );
      }
      return send(ctx, "NVDA");
    });
    expect(open).toMatchObject({ value: { status: "BLOCKED", reasons: ["OPEN_POSITION_LIMIT"] } });
  });

  it("refuses an entry on a symbol that already has a pending or open position", async () => {
    const client = await newClient();
    const second = await inClient(client, async (ctx) => {
      await send(ctx, "AAPL");
      return send(ctx, "AAPL");
    });
    expect(second).toMatchObject({
      value: { status: "BLOCKED", reasons: ["POSITION_ALREADY_OPEN"] },
    });
  });

  it("keeps the reservation when the response is lost: the intent is UNKNOWN", async () => {
    const client = await newClient();
    const { sent, rows, next, orders } = await inClient(client, async (ctx, state, sim) => {
      sim.inject({ kind: "dropPlaceResponse" });
      const sent = await send(ctx, "AAPL");
      const rows = snapshot(state);
      // The unknown order still holds its slot and its daily entry.
      await send(ctx, "MSFT");
      const next = await send(ctx, "NVDA");
      return { sent, rows, next, orders: await orderCount(sim) };
    });
    expect(sent).toMatchObject({ ok: true, value: { status: "PLACED", state: "UNKNOWN" } });
    expect(rows.counters).toEqual([{ consumed: 0, reserved: 1 }]);
    expect(rows.intents).toMatchObject([{ symbol: "AAPL", state: "UNKNOWN" }]);
    expect(next).toMatchObject({ value: { status: "BLOCKED", reasons: ["OPEN_POSITION_LIMIT"] } });
    // The lost-response order exists at the broker, and nothing placed it a second time.
    expect(orders).toBe(2);
  });

  it("does not place again when the repeat of an UNKNOWN intent arrives", async () => {
    const client = await newClient();
    const { repeat, orders } = await inClient(client, async (ctx, state, sim) => {
      sim.inject({ kind: "dropPlaceResponse" });
      await send(ctx, "AAPL");
      const id = state.storage.sql.exec<{ id: string }>("SELECT id FROM intents").one().id;
      const repeat = await sendEntry(ctx, { ...target("AAPL"), intentId: id, confirmedQty: 100 });
      return { repeat, orders: await orderCount(sim) };
    });
    expect(repeat).toMatchObject({ value: { status: "PLACED", state: "UNKNOWN", replay: true } });
    expect(orders).toBe(1);
  });

  it("releases the reservation of a REJECTED order and frees the slot", async () => {
    const client = await newClient();
    const sim = makeLocalSim({
      now: () => IN_SESSION,
      seed: "narrow",
      accounts: [{ accountId: "SIM-1" }],
      symbols: [
        { symbol: "AAPL", assetType: "equity", bid: usd(199), ask: usd(200) },
        { symbol: "MSFT", assetType: "equity", bid: usd(199), ask: usd(200) },
      ],
    });
    const { rejected, rows, retry } = await inClient(
      client,
      async (ctx, state) => {
        // SIM-2 is one of the client's accounts here but unknown to this broker, which refuses the order.
        const rejected = await send(ctx, "AAPL", { accountId: "SIM-2" });
        const rows = snapshot(state);
        const retry = await send(ctx, "AAPL", { accountId: "SIM-1" });
        return { rejected, rows, retry };
      },
      { sim },
    );
    expect(rejected).toMatchObject({ value: { status: "PLACED", state: "REJECTED" } });
    expect(rows.counters).toEqual([{ consumed: 0, reserved: 0 }]);
    expect(rows.intents).toMatchObject([{ state: "REJECTED" }]);
    const logged = await runInDurableObject(client.stub, (_i, state) =>
      state.storage.sql
        .exec<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'entry.rejected'")
        .one(),
    );
    expect(JSON.parse(logged.data_json)).toMatchObject({
      failure: "Rejected",
      code: expect.any(String),
    });
    // Neither the slot nor the symbol stayed held.
    expect(retry).toMatchObject({ value: { status: "PLACED", state: "ACKNOWLEDGED" } });
  });

  it("treats a rate-limited placement as not placed and releases it", async () => {
    const client = await newClient();
    const { sent, rows } = await inClient(client, async (ctx, state, sim) => {
      sim.inject({ kind: "rateLimited", operation: "placeOrder" });
      return { sent: await send(ctx, "AAPL"), rows: snapshot(state) };
    });
    expect(sent).toMatchObject({ value: { state: "REJECTED" } });
    expect(rows.counters).toEqual([{ consumed: 0, reserved: 0 }]);
  });

  it("refuses entries while a reconciliation is pending, without calling the broker", async () => {
    const client = await newClient();
    const { result, orders, rows } = await inClient(client, async (ctx, state, sim) => {
      holdForReconciliation(state.storage);
      return {
        result: await send(ctx, "AAPL"),
        orders: await orderCount(sim),
        rows: snapshot(state),
      };
    });
    expect(result).toMatchObject({
      value: { status: "BLOCKED", reasons: ["RECONCILIATION_PENDING"] },
    });
    expect(orders).toBe(0);
    expect(rows).toEqual({ counters: [], intents: [] });
  });

  it("refuses entries while the connection is unusable", async () => {
    const client = await newClient();
    await env.DB.prepare("UPDATE broker_connection SET status = 'EXPIRED' WHERE user_id = ?")
      .bind(client.userId)
      .run();
    const result = await inClient(client, (ctx) => send(ctx, "AAPL"));
    expect(result).toMatchObject({
      value: { status: "BLOCKED", reasons: ["CONNECTION_UNUSABLE"] },
    });
  });

  it("refuses outside the regular session and reserves nothing", async () => {
    const client = await newClient();
    const { result, rows } = await inClient(
      client,
      async (ctx, state) => ({ result: await send(ctx, "AAPL"), rows: snapshot(state) }),
      { now: SATURDAY },
    );
    expect(result).toMatchObject({
      value: { status: "BLOCKED", reasons: ["OUTSIDE_REGULAR_SESSION"] },
    });
    expect(rows).toEqual({ counters: [], intents: [] });
  });

  it("does not let the SIM account guard be bypassed: an unlisted account is refused before any order", async () => {
    const client = await newClient();
    const sim = newSim();
    const script = scriptedFetch(() => json(accountsFixture));
    const made = makeTradeStationAdapter({
      mode: "SIM",
      accessToken: okToken,
      fetch: script.fetch,
      now: () => IN_SESSION,
    });
    if (!made.ok) throw new Error(made.reason);
    // Data from the simulation, placement through the real SIM adapter and its account guard.
    const broker: BrokerAdapterShape = { ...sim.adapter, placeOrder: made.adapter.placeOrder };
    const { result, rows } = await inClient(
      client,
      async (ctx, state) => ({ result: await send(ctx, "AAPL"), rows: snapshot(state) }),
      { broker },
    );
    expect(result).toMatchObject({ value: { status: "PLACED", state: "REJECTED" } });
    expect(rows.counters).toEqual([{ consumed: 0, reserved: 0 }]);
    expect(script.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(
      script.calls.every((call) => call.url.startsWith("https://sim-api.tradestation.com/v3/")),
    ).toBe(true);
  });
});

describe("entryLimits", () => {
  it("counts the entries and slots that block a new entry, today only", async () => {
    const client = await newClient();
    const counts = await inClient(client, async (ctx, state) => {
      const empty = entryLimits(ctx);
      await send(ctx, "AAPL");
      const afterOne = entryLimits(ctx);
      // Yesterday's consumed entries belong to another market day.
      state.storage.sql.exec(
        "INSERT INTO entry_counters (mode, session_date, consumed, reserved) VALUES ('SIM', '2026-11-03', 3, 0)",
      );
      return { empty, afterOne, withOldDay: entryLimits(ctx) };
    });
    expect(counts.empty).toEqual({ positions: 0, maxPositions: 2, entriesToday: 0, maxEntries: 3 });
    expect(counts.afterOne).toMatchObject({ positions: 1, entriesToday: 1 });
    expect(counts.withOldDay).toEqual(counts.afterOne);
  });

  it("is served by the limits RPC, SIM only and without extra fields", async () => {
    const client = await newClient();
    expect(await client.stub.limits({ mode: "SIM" })).toMatchObject({
      ok: true,
      value: { positions: 0, maxPositions: 2, entriesToday: 0, maxEntries: 3 },
    });
    expect(await client.stub.limits({ mode: "REAL" })).toMatchObject({ ok: false });
    expect(await client.stub.limits({ mode: "SIM", size: 1 })).toMatchObject({ ok: false });
  });
});

describe("the RPC surface", () => {
  it("rejects SIZE, quantity and price sent by the browser", async () => {
    const client = await newClient();
    for (const extra of [{ size: 1 }, { sizeUsd: 1 }, { qty: 1 }, { quantity: 1 }, { price: 1 }]) {
      expect(await client.stub.prepareEntry({ ...target("AAPL"), ...extra })).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
      });
      expect(
        await client.stub.sendEntry({
          ...target("AAPL"),
          intentId: "A".repeat(22),
          confirmedQty: 1,
          ...extra,
        }),
      ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
  });

  it("rejects an intent id that does not fit an OrderConfirmID", async () => {
    const client = await newClient();
    for (const intentId of ["short", "A".repeat(23), "a b".padEnd(22, "c")]) {
      expect(
        await client.stub.sendEntry({ ...target("AAPL"), intentId, confirmedQty: 1 }),
      ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
  });

  it("refuses REAL on both entry methods", async () => {
    const client = await newClient();
    const real = { ...target("AAPL"), mode: "REAL" };
    expect(await client.stub.prepareEntry(real)).toMatchObject({ ok: false, code: "MODE_NOT_SIM" });
    expect(
      await client.stub.sendEntry({ ...real, intentId: "A".repeat(22), confirmedQty: 1 }),
    ).toMatchObject({ ok: false, code: "MODE_NOT_SIM" });
  });

  it("trades through the local simulation only when the environment allows it", async () => {
    const client = await newClient();
    localSimFor(
      client.userId,
      {
        now: () => IN_SESSION,
        seed: "rpc",
        accounts: [{ accountId: "SIM-1" }],
        symbols: [{ symbol: "AAPL", assetType: "equity", bid: usd(199), ask: usd(200) }],
      },
      { reset: true },
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(IN_SESSION);
    const prepared = await client.stub.prepareEntry(target("AAPL"));
    expect(prepared).toMatchObject({ ok: true, value: { status: "READY", qty: 100 } });
    if (!prepared.ok || prepared.value.status !== "READY") return;
    const sent = await client.stub.sendEntry({
      ...target("AAPL"),
      intentId: prepared.value.intentId,
      confirmedQty: 100,
    });
    expect(sent).toMatchObject({ ok: true, value: { status: "PLACED", state: "ACKNOWLEDGED" } });
  });
});
