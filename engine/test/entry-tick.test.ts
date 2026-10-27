import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LIVE_ENTRY_INPUTS_TTL_MS } from "#lib/domain/config.ts";
import { prepareEntry, sendEntry } from "../src/entries.ts";
import { EntryInputsCache } from "../src/entry-inputs.ts";
import { TokenRefresher } from "../src/refresh.ts";
import { runSync } from "../src/sync.ts";
import type { Quote } from "../src/broker/adapter.ts";
import { IN_SESSION, inClient, newClient, newSim, type Clock } from "./sync-helpers.ts";

const target = { mode: "SIM", accountId: "SIM-1", symbol: "AAPL", assetType: "equity" } as const;

const streamedQuote = (ask: number, symbol = "AAPL"): Quote => ({
  symbol,
  bid: ask - 1_000_000,
  ask,
  last: ask,
  tradeTime: 0,
  receivedAt: IN_SESSION,
  isDelayed: false,
  isHalted: false,
});

/** The D1 the tick sees, counting each statement and the time it takes. */
function countedDb(): { db: D1Database; statements: string[]; elapsedMs: () => number } {
  const statements: string[] = [];
  let elapsed = 0;
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key !== "prepare") return Reflect.get(target, key, target) as unknown;
      return (query: string) => {
        statements.push(query);
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get(inner, name) {
            const value = Reflect.get(inner, name, inner) as unknown;
            if (name === "bind") {
              return (...args: unknown[]) =>
                new Proxy((inner.bind as (...a: unknown[]) => D1PreparedStatement)(...args), this);
            }
            if (name !== "first" && name !== "all" && name !== "run") return value;
            return async (...args: unknown[]) => {
              const started = performance.now();
              try {
                return await (value as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
              } finally {
                elapsed += performance.now() - started;
              }
            };
          },
        });
      };
    },
  });
  return { db, statements, elapsedMs: () => elapsed };
}

const withCache = (clock: Clock) => new EntryInputsCache(() => clock.now, LIVE_ENTRY_INPUTS_TTL_MS);

const setSizeUsd = (userId: string, sizeUsd: number) =>
  env.DB.prepare("UPDATE client_settings SET size_usd = ? WHERE user_id = ?")
    .bind(sizeUsd, userId)
    .run();

describe("sizing one streamed tick of the entry symbol", () => {
  it("reads D1 twice per tick without the cache (before)", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    await inClient(client, clock, newSim(clock).adapter, async (ctx) => {
      await prepareEntry(ctx, target, streamedQuote(200_000_000));
      const counted = countedDb();
      const started = performance.now();
      const result = await prepareEntry(
        { ...ctx, db: counted.db },
        target,
        streamedQuote(201_000_000),
      );
      const totalMs = performance.now() - started;
      expect(result.ok && result.value.status).toBe("READY");
      console.info(
        `tick without the cache: ${counted.statements.length} D1 statements, ${counted.elapsedMs().toFixed(2)} ms in D1 of ${totalMs.toFixed(2)} ms`,
      );
      expect(counted.statements).toHaveLength(2);
    });
  });

  it("reads no D1 once the inputs are held (after)", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    await inClient(client, clock, newSim(clock).adapter, async (ctx) => {
      const cache = withCache(clock);
      await prepareEntry(ctx, target, streamedQuote(200_000_000), cache);
      const counted = countedDb();
      const started = performance.now();
      const result = await prepareEntry(
        { ...ctx, db: counted.db },
        target,
        streamedQuote(201_000_000),
        cache,
      );
      const totalMs = performance.now() - started;
      console.info(
        `tick with the cache: ${counted.statements.length} D1 statements, ${totalMs.toFixed(2)} ms`,
      );
      expect(counted.statements).toEqual([]);
      expect(result.ok && result.value.status === "READY" && result.value.askMicros).toBe(
        201_000_000,
      );
    });
  });

  it("sizes from the new SIZE once the cache is invalidated, and not before", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    await inClient(client, clock, newSim(clock).adapter, async (ctx) => {
      const cache = withCache(clock);
      const qtyOf = async () => {
        const result = await prepareEntry(ctx, target, streamedQuote(200_000_000), cache);
        return result.ok && result.value.status === "READY" ? result.value.qty : null;
      };
      expect(await qtyOf()).toBe(100);
      await setSizeUsd(client.userId, 40_000);
      expect(await qtyOf()).toBe(100);
      cache.invalidate();
      expect(await qtyOf()).toBe(200);
    });
  });

  it("drops the coordinator's held SIZE when the admin saves settings (the RPC)", async () => {
    const client = await newClient();
    // White-box on purpose: the cache is private to the coordinator, and a real socket needs a
    // broker with a quote stream, which the local simulation lacks.
    const heldSize = () =>
      runInDurableObject(client.stub, async (instance) => {
        const ctx = { db: env.DB, userId: client.userId };
        return (await instance["entryInputs"].read(ctx)).sizeUsd;
      });
    expect(await heldSize()).toBe(20_000);
    await setSizeUsd(client.userId, 40_000);
    expect(await heldSize()).toBe(20_000);
    expect(await client.stub.settingsChanged({ mode: "SIM" })).toEqual({ ok: true, value: null });
    expect(await heldSize()).toBe(40_000);
  });

  it("refuses a settingsChanged call outside SIM", async () => {
    const client = await newClient();
    expect(await client.stub.settingsChanged({ mode: "REAL" })).toMatchObject({ ok: false });
  });

  it("expires a copy that a missed invalidation left behind", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    await inClient(client, clock, newSim(clock).adapter, async (ctx) => {
      const cache = withCache(clock);
      await prepareEntry(ctx, target, streamedQuote(200_000_000), cache);
      await setSizeUsd(client.userId, 40_000);
      clock.now += LIVE_ENTRY_INPUTS_TTL_MS + 1;
      const result = await prepareEntry(ctx, target, streamedQuote(200_000_000), cache);
      expect(result.ok && result.value.status === "READY" && result.value.qty).toBe(200);
    });
  });

  it("does not keep a read that an invalidation overtook", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    await inClient(client, clock, newSim(clock).adapter, async (ctx) => {
      const cache = withCache(clock);
      const reading = cache.read(ctx);
      cache.invalidate();
      await reading;
      await setSizeUsd(client.userId, 40_000);
      const result = await prepareEntry(ctx, target, streamedQuote(200_000_000), cache);
      expect(result.ok && result.value.status === "READY" && result.value.qty).toBe(200);
    });
  });

  it("sees a disconnect at once through the refresher's change signal", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    await inClient(client, clock, newSim(clock).adapter, async (ctx) => {
      const cache = withCache(clock);
      const tokens = new TokenRefresher({
        sql: ctx.sql,
        storage: ctx.storage,
        db: env.DB,
        userId: client.userId,
        cipher: ctx.cipher,
        clock: () => clock.now,
        retryDelayMs: 0,
        changed: () => cache.invalidate(),
      });
      const first = await prepareEntry(
        { ...ctx, tokens },
        target,
        streamedQuote(200_000_000),
        cache,
      );
      expect(first.ok && first.value.status).toBe("READY");
      await env.DB.prepare("DELETE FROM broker_connection WHERE user_id = ?")
        .bind(client.userId)
        .run();
      tokens.forget();
      const second = await prepareEntry(
        { ...ctx, tokens },
        target,
        streamedQuote(200_000_000),
        cache,
      );
      expect(second).toEqual({
        ok: true,
        value: { status: "BLOCKED", reasons: ["NOT_CONNECTED"] },
      });
    });
  });

  it("blocks on a limit reached since the last tick, with the cache still held", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.setFill({ kind: "instant" });
    const client = await newClient();
    await inClient(client, clock, sim.adapter, async (ctx) => {
      const cache = withCache(clock);
      const fresh = await prepareEntry(
        ctx,
        { ...target, symbol: "NVDA" },
        streamedQuote(200_000_000, "NVDA"),
        cache,
      );
      expect(JSON.stringify(fresh)).toContain("READY");
      for (const symbol of ["AAPL", "MSFT"] as const) {
        const prepared = await prepareEntry(ctx, { ...target, symbol });
        if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
        await sendEntry(ctx, {
          ...target,
          symbol,
          intentId: prepared.value.intentId,
          confirmedQty: prepared.value.qty,
        });
      }
      await runSync(ctx);
      const counted = countedDb();
      const blocked = await prepareEntry(
        { ...ctx, db: counted.db },
        { ...target, symbol: "NVDA" },
        streamedQuote(200_000_000, "NVDA"),
        cache,
      );
      expect(counted.statements).toEqual([]);
      expect(blocked.ok && blocked.value.status === "BLOCKED" && blocked.value.reasons).toContain(
        "OPEN_POSITION_LIMIT",
      );
    });
  });
});
