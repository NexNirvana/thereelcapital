import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { localSimFor } from "../src/broker/provider.ts";
import type { BrokerAdapterShape } from "../src/broker/adapter.ts";
import { Unknown } from "../src/broker/errors.ts";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { holdForReconciliation, reconciliationPending } from "../src/refresh.ts";
import { EVENT_RETENTION_MS, SYNC_INTERVAL_MS } from "#lib/domain/config.ts";
import { runSync, syncWanted } from "../src/sync.ts";
import {
  ACCOUNTS,
  IN_SESSION,
  inClient,
  newClient,
  newSim,
  run,
  usd,
  type Clock,
} from "./sync-helpers.ts";

const SATURDAY = Date.UTC(2026, 10, 7, 15, 0, 0);
const target = (symbol: string) =>
  ({ mode: "SIM", accountId: "SIM-1", symbol, assetType: "equity" }) as const;

async function enter(ctx: EntryContext, symbol: string): Promise<string> {
  const prepared = await prepareEntry(ctx, target(symbol));
  if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
  await sendEntry(ctx, {
    ...target(symbol),
    intentId: prepared.value.intentId,
    confirmedQty: prepared.value.qty,
  });
  return prepared.value.intentId;
}

const events = (ctx: EntryContext, type: string) =>
  ctx.sql.exec("SELECT level, data_json FROM events WHERE type = ?", type).toArray();
const protection = (ctx: EntryContext) =>
  ctx.sql
    .exec("SELECT protection_state AS p FROM positions WHERE status != 'CLOSED' ORDER BY symbol")
    .toArray();
const blockedReasons = async (ctx: EntryContext, symbol: string) => {
  const result = await prepareEntry(ctx, target(symbol));
  return result.ok && result.value.status === "BLOCKED" ? result.value.reasons : "ready";
};

/** An open position, as a first pass would have left it, and a held reconciliation. */
async function withOpenPosition(ctx: EntryContext, symbol = "AAPL") {
  await enter(ctx, symbol);
  expect(await runSync(ctx)).toMatchObject({ reconciled: true });
}

describe("event retention", () => {
  const oldEvents = (ctx: EntryContext) =>
    ctx.sql.exec("SELECT id FROM events WHERE type = 'test.old'").toArray();
  const writeOld = (ctx: EntryContext) =>
    ctx.sql.exec(
      "INSERT INTO events (at, mode, level, type, message) VALUES (?, 'SIM', 'info', 'test.old', 'm')",
      IN_SESSION - EVENT_RETENTION_MS - 1,
    );

  it("a good pass prunes events past the retention window", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await enter(ctx, "AAPL");
      writeOld(ctx);
      expect(await runSync(ctx)).toMatchObject({ reconciled: true });
      expect(oldEvents(ctx)).toEqual([]);
    });
  });

  it("a failed pass leaves old events alone", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await withOpenPosition(ctx);
      writeOld(ctx);
      sim.inject({ kind: "authExpired", operation: "orders" });
      expect(await runSync(ctx)).toMatchObject({ reconciled: false });
      expect(oldEvents(ctx)).toHaveLength(1);
    });
  });
});

describe("degraded states", () => {
  it("token expired: entries blocked, protection unverified, loop retries while the token can be renewed", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await withOpenPosition(ctx);
      sim.inject({ kind: "authExpired", operation: "orders" });

      const result = await runSync(ctx);

      expect(result).toEqual({ reconciled: false, nextInMs: SYNC_INTERVAL_MS });
      expect(events(ctx, "sync.token_expired")).toHaveLength(1);
      expect(protection(ctx)).toEqual([{ p: "unverified" }]);
      expect(await blockedReasons(ctx, "MSFT")).toEqual(["RECONCILIATION_PENDING"]);
    });
  });

  it("token revoked for good: the loop stops and waits for a reconnect", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await env.DB.prepare("UPDATE broker_connection SET status = 'REVOKED' WHERE user_id = ?")
      .bind(client.userId)
      .run();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      sim.inject({ kind: "authExpired", operation: "orders" });
      expect(await runSync(ctx)).toEqual({ reconciled: false, nextInMs: null });
      expect(events(ctx, "sync.token_expired")).toHaveLength(1);
    });
  });

  it("rate limited: waits as long as the broker asks, never faster than the tick", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await withOpenPosition(ctx);
      sim.inject({ kind: "rateLimited", operation: "positions", retryAfterMs: 30_000 });

      expect(await runSync(ctx)).toEqual({ reconciled: false, nextInMs: 30_000 });
      expect(events(ctx, "sync.rate_limited")).toHaveLength(1);
      expect(protection(ctx)).toEqual([{ p: "unverified" }]);
      expect(await blockedReasons(ctx, "MSFT")).toEqual(["RECONCILIATION_PENDING"]);

      sim.inject({ kind: "rateLimited", operation: "orders", retryAfterMs: 1 });
      expect(await runSync(ctx)).toMatchObject({ nextInMs: SYNC_INTERVAL_MS });
      // Same condition on the next tick: logged once, not again.
      expect(events(ctx, "sync.rate_limited")).toHaveLength(1);
    });
  });

  it("broker errors: blocked until the next good sync, which restores protection and says so", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const failing: BrokerAdapterShape = {
      ...sim.adapter,
      orders: () => Effect.fail(new Unknown({ operation: "orders", detail: "502" })),
    };
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await withOpenPosition(ctx);

      expect(await runSync({ ...ctx, broker: failing })).toEqual({
        reconciled: false,
        nextInMs: SYNC_INTERVAL_MS,
      });
      expect(events(ctx, "sync.broker_error")).toHaveLength(1);
      expect(protection(ctx)).toEqual([{ p: "unverified" }]);
      expect(await blockedReasons(ctx, "MSFT")).toEqual(["RECONCILIATION_PENDING"]);

      expect(await runSync(ctx)).toMatchObject({ reconciled: true });
      expect(events(ctx, "sync.recovered")).toHaveLength(1);
      // The monitor (D36) found a fresh quote and a working token.
      expect(protection(ctx)).toEqual([{ p: "verified" }]);
      expect(await blockedReasons(ctx, "MSFT")).toBe("ready");
    });
  });

  it("stale or missing quotes block entries but not the sync", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await withOpenPosition(ctx);
      sim.inject({ kind: "quoteStale", symbol: "MSFT" });
      expect(await blockedReasons(ctx, "MSFT")).toEqual(["QUOTE_STALE"]);
      sim.inject({ kind: "quoteMissing", symbol: "MSFT" });
      expect(await blockedReasons(ctx, "MSFT")).toEqual(["QUOTE_MISSING"]);
      expect(await runSync(ctx)).toMatchObject({ reconciled: true });
    });
  });

  it("outside the regular session entries are blocked and the sync still reconciles", async () => {
    const clock: Clock = { now: SATURDAY };
    const sim = newSim(clock);
    await run(
      sim.adapter.placeOrder({
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
        tradeAction: "BUY",
        quantity: 10,
        orderConfirmId: "elsewhere-0000000010",
      }),
    );
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      expect(await blockedReasons(ctx, "MSFT")).toEqual(["OUTSIDE_REGULAR_SESSION"]);
      expect(await runSync(ctx)).toMatchObject({ reconciled: true });
      expect(ctx.sql.exec("SELECT COUNT(*) AS n FROM positions").one()).toEqual({ n: 1 });
    });
  });

  it("an UNKNOWN exit keeps its position unverified even after a good sync", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      await withOpenPosition(ctx);
      const positionId = ctx.sql.exec<{ id: string }>("SELECT id FROM positions").one().id;
      ctx.sql.exec(
        `INSERT INTO intents (id, mode, kind, account_id, position_id, symbol, asset_type, trade_action, qty,
           state, order_confirm_id, created_at, updated_at)
         VALUES ('exit-unknown-0000000001', 'SIM', 'exit', 'SIM-1', ?, 'AAPL', 'equity', 'SELL', 30,
           'UNKNOWN', 'exit-unknown-0000000001', ?, ?)`,
        positionId,
        clock.now,
        clock.now,
      );

      expect(await runSync(ctx)).toMatchObject({ reconciled: true });
      expect(await runSync(ctx)).toMatchObject({ reconciled: true });

      expect(protection(ctx)).toEqual([{ p: "unverified" }]);
      // Logged when the count changes, not on every tick.
      expect(events(ctx, "sync.unknown_pending")).toHaveLength(1);
    });
  });
});

describe("reconnecting", () => {
  it("never resets counters, reservations or scale-out steps", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.setFill({ kind: "delayed", afterMs: 3_600_000 });
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      // One entry working (reserved), one position filled earlier with a step already used.
      await enter(ctx, "MSFT");
      sim.setFill({ kind: "instant" });
      await enter(ctx, "AAPL");
      expect(await runSync(ctx)).toMatchObject({ reconciled: true });
      ctx.sql.exec("UPDATE scaleout_steps SET state = 'done' WHERE idx IN (0, 1)");
      const before = {
        counters: ctx.sql.exec("SELECT consumed, reserved FROM entry_counters").toArray(),
        steps: ctx.sql
          .exec("SELECT idx, state FROM scaleout_steps ORDER BY position_id, idx")
          .toArray(),
        intents: ctx.sql.exec("SELECT id, state FROM intents ORDER BY id").toArray(),
      };

      // What connect and disconnect do: replace the accounts and hold for reconciliation.
      ctx.sql.exec("DELETE FROM broker_accounts");
      for (const accountId of ACCOUNTS) {
        ctx.sql.exec(
          "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', ?, 'Margin')",
          accountId,
        );
      }
      holdForReconciliation(ctx.storage);
      expect(reconciliationPending(ctx.storage)).toBe(true);
      expect(await runSync(ctx)).toMatchObject({ reconciled: true });
      expect(await runSync(ctx)).toMatchObject({ reconciled: true });

      expect({
        counters: ctx.sql.exec("SELECT consumed, reserved FROM entry_counters").toArray(),
        steps: ctx.sql
          .exec("SELECT idx, state FROM scaleout_steps ORDER BY position_id, idx")
          .toArray(),
        intents: ctx.sql.exec("SELECT id, state FROM intents ORDER BY id").toArray(),
      }).toEqual(before);
      expect(before.counters).toEqual([{ consumed: 1, reserved: 1 }]);
    });
  });

  it("does not lift a hold that landed while the broker was being read", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      holdForReconciliation(ctx.storage);
      const pass = runSync(ctx);
      // A disconnect-style hold arrives while the pass is waiting on the broker.
      holdForReconciliation(ctx.storage);
      expect(await pass).toMatchObject({ reconciled: false });
      expect(reconciliationPending(ctx.storage)).toBe(true);
    });
  });
});

describe("syncWanted", () => {
  it("is true only with a connection and something open or pending", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx, state) => {
      expect(syncWanted(state.storage)).toBe(false);

      ctx.sql.exec("DELETE FROM broker_accounts");
      holdForReconciliation(state.storage);
      expect(syncWanted(state.storage)).toBe(false); // nothing to read with
      for (const accountId of ACCOUNTS) {
        ctx.sql.exec(
          "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', ?, 'Margin')",
          accountId,
        );
      }
      expect(syncWanted(state.storage)).toBe(true); // a reconciliation is pending
      expect(await runSync(ctx)).toEqual({ reconciled: true, nextInMs: null });
      expect(syncWanted(state.storage)).toBe(false);

      await enter(ctx, "AAPL");
      expect(syncWanted(state.storage)).toBe(true); // an unfinished intent
    });
  });
});

describe("the alarm loop", () => {
  // The tick is due (alarm_due:sync) but the real alarm is parked an hour away, so workerd never
  // fires it on its own while runDurableObjectAlarm runs the tick: two concurrent ticks would race.
  const PARKED_ALARM = () => Date.now() + 3_600_000;

  /** A Durable Object whose broker is the client's own local simulation, driven by the real alarm. */
  async function loopClient() {
    const client = await newClient();
    const sim = localSimFor(
      client.userId,
      {
        now: Date.now,
        seed: client.userId,
        accounts: ACCOUNTS.map((accountId) => ({ accountId })),
        symbols: [{ symbol: "AAPL", assetType: "equity", bid: usd(199), ask: usd(200) }],
      },
      { reset: true },
    );
    return { ...client, sim };
  }

  const seedEntry = (client: Awaited<ReturnType<typeof loopClient>>, orderId: string) =>
    runInDurableObject(client.stub, (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO intents (id, mode, kind, account_id, symbol, asset_type, trade_action, qty, state,
           order_confirm_id, broker_order_id, created_at, updated_at)
         VALUES ('loop-entry-00000000001', 'SIM', 'entry', 'SIM-1', 'AAPL', 'equity', 'BUY', 100,
           'ACKNOWLEDGED', 'loop-entry-00000000001', ?, ?, ?)`,
        orderId,
        Date.now(),
        Date.now(),
      );
      state.storage.sql.exec(
        "INSERT INTO entry_counters (mode, session_date, consumed, reserved) VALUES ('SIM', '2026-11-04', 0, 1)",
      );
      // The entry's day: reconcile settles the counter of the day the intent was created.
      state.storage.sql.exec("UPDATE intents SET created_at = ?", Date.UTC(2026, 10, 4, 15));
    });

  it("runs while a position is open, and stops once nothing is open or pending", async () => {
    const client = await loopClient();
    const placed = await run(
      client.sim.adapter.placeOrder({
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
        tradeAction: "BUY",
        quantity: 100,
        orderConfirmId: "loop-entry-00000000001",
      }),
    );
    await seedEntry(client, placed.orderId);
    const due = (name: "sync" | "refresh") =>
      runInDurableObject(
        client.stub,
        (_i, state) => state.storage.kv.get<number>(`alarm_due:${name}`) ?? null,
      );
    await runInDurableObject(client.stub, (_i, state) => {
      state.storage.kv.put("alarm_due:sync", Date.now());
      return state.storage.setAlarm(PARKED_ALARM());
    });

    // Tick 1: the fill is applied, the position is open, so the loop goes on.
    await runDurableObjectAlarm(client.stub);
    expect(await due("sync")).not.toBeNull();
    expect(
      await runInDurableObject(client.stub, (_i, state) =>
        state.storage.sql.exec("SELECT status FROM positions").toArray(),
      ),
    ).toEqual([{ status: "OPEN" }]);

    // The position is sold elsewhere: the next tick closes it and the loop ends.
    await run(
      client.sim.adapter.placeOrder({
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
        tradeAction: "SELL",
        quantity: 100,
        orderConfirmId: "loop-sell-000000000001",
      }),
    );
    await runInDurableObject(client.stub, (_i, state) => {
      state.storage.kv.put("alarm_due:sync", Date.now());
      return state.storage.setAlarm(PARKED_ALARM());
    });
    await runDurableObjectAlarm(client.stub);

    expect(await due("sync")).toBeNull();
    expect(
      await runInDurableObject(client.stub, (_i, state) => state.storage.getAlarm()),
    ).toBeNull();
    expect(
      await runInDurableObject(client.stub, (_i, state) =>
        state.storage.sql.exec("SELECT status FROM positions").toArray(),
      ),
    ).toEqual([{ status: "CLOSED" }]);
  });

  it("the sync RPC restarts a stopped loop when the pass finds work", async () => {
    const client = await loopClient();
    await run(
      client.sim.adapter.placeOrder({
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
        tradeAction: "BUY",
        quantity: 10,
        orderConfirmId: "elsewhere-0000000020",
      }),
    );
    const due = () =>
      runInDurableObject(
        client.stub,
        (_i, state) => state.storage.kv.get<number>("alarm_due:sync") ?? null,
      );
    expect(await due()).toBeNull();

    expect(await client.stub.sync({ mode: "SIM" })).toMatchObject({ ok: true });

    // The pass adopted a position nobody was watching, so the loop is running again.
    expect(await due()).toBeGreaterThan(Date.now());
  });

  it("serves the refresh and the sync from one alarm: neither starves the other", async () => {
    const client = await loopClient();
    const placed = await run(
      client.sim.adapter.placeOrder({
        accountId: "SIM-1",
        symbol: "AAPL",
        assetType: "equity",
        tradeAction: "BUY",
        quantity: 100,
        orderConfirmId: "loop-entry-00000000001",
      }),
    );
    await seedEntry(client, placed.orderId);
    const later = Date.now() + 3_600_000;
    await runInDurableObject(client.stub, async (_i, state) => {
      // The refresh is due far away; the sync is due now. The alarm is for the sync.
      state.storage.kv.put("alarm_due:refresh", later);
      state.storage.kv.put("alarm_due:sync", Date.now());
      await state.storage.setAlarm(PARKED_ALARM());
    });

    await runDurableObjectAlarm(client.stub);

    const after = await runInDurableObject(client.stub, async (_i, state) => ({
      refresh: state.storage.kv.get<number>("alarm_due:refresh"),
      sync: state.storage.kv.get<number>("alarm_due:sync"),
      alarm: await state.storage.getAlarm(),
    }));
    // The sync ran and rescheduled itself a tick ahead; the refresh kept its own, later time.
    expect(after.refresh).toBe(later);
    expect(after.sync).toBeGreaterThan(Date.now());
    expect(after.sync).toBeLessThan(later);
    expect(after.alarm).toBe(after.sync);
  });
});
