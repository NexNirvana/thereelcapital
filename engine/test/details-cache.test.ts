import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { BrokerAdapterShape } from "../src/broker/adapter.ts";
import { prepareEntry, sendEntry } from "../src/entries.ts";
import { exitPosition } from "../src/exits.ts";
import { runSync } from "../src/sync.ts";
import { IN_SESSION, inClient, newClient, newSim, type Clock } from "./sync-helpers.ts";

const target = (symbol: string, accountId = "SIM-1") =>
  ({ mode: "SIM", accountId, symbol, assetType: "equity" }) as const;

/** Counts every broker call and records when each of symbolDetails and quotes starts and ends. */
function probe(inner: BrokerAdapterShape, delayMs = 0) {
  const calls: Record<string, number> = {};
  const timeline: string[] = [];
  const wrapped = { ...inner } as Record<string, unknown>;
  for (const [name, op] of Object.entries(inner)) {
    if (typeof op !== "function") continue;
    wrapped[name] = (...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      const effect = (op as (...a: unknown[]) => Effect.Effect<unknown, never>)(...args);
      if (name !== "symbolDetails" && name !== "quotes") return effect;
      return Effect.gen(function* () {
        timeline.push(`${name}:start`);
        yield* Effect.sleep(delayMs);
        const value = yield* effect;
        timeline.push(`${name}:end`);
        return value;
      });
    };
  }
  return { broker: wrapped as unknown as BrokerAdapterShape, calls, timeline };
}

describe("symbol details cache", () => {
  it("asks the broker once across prepare, send, sync and exit", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    sim.setFill({ kind: "instant" });
    const counted = probe(sim.adapter);
    const client = await newClient();
    await inClient(client, clock, counted.broker, async (ctx) => {
      const base = target("AAPL");
      const prepared = await prepareEntry(ctx, base);
      if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
      await sendEntry(ctx, {
        ...base,
        intentId: prepared.value.intentId,
        confirmedQty: prepared.value.qty,
      });
      await runSync(ctx);
      const position = ctx.sql
        .exec<{ id: string }>("SELECT id FROM positions WHERE symbol = 'AAPL'")
        .one();
      const exit = await exitPosition(ctx, {
        mode: "SIM",
        positionId: position.id,
        step: "ALL_OUT",
      });
      expect(exit.ok && exit.value.status).toBe("PLACED");
    });
    expect(counted.calls.symbolDetails).toBe(1);
  });

  it("reads the details and the quote together, not one after the other", async () => {
    const clock: Clock = { now: IN_SESSION };
    const counted = probe(newSim(clock).adapter, 20);
    const client = await newClient();
    const prepared = await inClient(client, clock, counted.broker, (ctx) =>
      prepareEntry(ctx, target("AAPL")),
    );
    expect(prepared.ok && prepared.value.status).toBe("READY");
    expect(counted.timeline.slice(0, 2).sort()).toEqual(["quotes:start", "symbolDetails:start"]);
  });

  it("keeps the details of each client apart and drops them on the next market day", async () => {
    const clock: Clock = { now: IN_SESSION };
    const counted = probe(newSim(clock).adapter);
    const first = await newClient();
    const second = await newClient();
    const prepare = (client: typeof first) =>
      inClient(client, clock, counted.broker, (ctx) => prepareEntry(ctx, target("AAPL")));
    await prepare(first);
    await prepare(first);
    expect(counted.calls.symbolDetails).toBe(1);
    await prepare(second);
    expect(counted.calls.symbolDetails).toBe(2);
    clock.now += 24 * 3_600_000;
    await prepare(first);
    expect(counted.calls.symbolDetails).toBe(3);
  });

  it("does not keep a rejection: the next attempt asks again", async () => {
    const clock: Clock = { now: IN_SESSION };
    const counted = probe(newSim(clock).adapter);
    const client = await newClient();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await inClient(client, clock, counted.broker, (ctx) =>
        prepareEntry(ctx, target("NOPE")),
      );
      expect(result).toEqual({
        ok: true,
        value: { status: "BLOCKED", reasons: ["SYMBOL_DETAILS_MISSING"] },
      });
      expect(counted.calls.symbolDetails).toBe(attempt);
    }
  });

  it("keeps the blocked reasons, and makes no broker call before the connection checks pass", async () => {
    const clock: Clock = { now: IN_SESSION };
    const counted = probe(newSim(clock).adapter);
    const client = await newClient();
    const blocked = (args: ReturnType<typeof target>) =>
      inClient(client, clock, counted.broker, (ctx) => prepareEntry(ctx, args));
    expect(await blocked(target("AAPL", "SIM-9"))).toEqual({
      ok: true,
      value: { status: "BLOCKED", reasons: ["ACCOUNT_NOT_OWNED"] },
    });
    expect(counted.calls.symbolDetails).toBeUndefined();
    expect(counted.calls.quotes).toBeUndefined();

    await env_db_run("DELETE FROM client_settings WHERE user_id = ?", client.userId);
    expect(await blocked(target("NOPE"))).toEqual({
      ok: true,
      value: { status: "BLOCKED", reasons: ["SIZE_UNAVAILABLE"] },
    });

    await env_db_run("DELETE FROM broker_connection WHERE user_id = ?", client.userId);
    const before = { ...counted.calls };
    expect(await blocked(target("AAPL"))).toEqual({
      ok: true,
      value: { status: "BLOCKED", reasons: ["NOT_CONNECTED"] },
    });
    expect(counted.calls).toEqual(before);
  });
});

async function env_db_run(sql: string, userId: string) {
  await env.DB.prepare(sql).bind(userId).run();
}
