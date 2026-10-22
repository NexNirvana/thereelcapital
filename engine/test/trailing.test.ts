// Trailing activation and the engine-held trailing exit (D36, docs/domain-rules.md §8).
// Local simulation only.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LocalSim } from "../src/broker/local-sim/sim.ts";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { STOP_REJECTED_COOLDOWN_MS } from "#lib/domain/config.ts";
import { exitPosition } from "../src/exits.ts";
import { runSync } from "../src/sync.ts";
import { activateTrailing } from "../src/trailing.ts";
import { IN_SESSION, inClient, newClient, newSim, usd, type Clock } from "./sync-helpers.ts";

const ASK = 200;

async function openPosition(ctx: EntryContext, sim: LocalSim, qty: number) {
  await env.DB.prepare("UPDATE client_settings SET size_usd = ? WHERE user_id = ?")
    .bind(ASK * qty, ctx.userId)
    .run();
  sim.setFill({ kind: "instant" });
  const args = { mode: "SIM", accountId: "SIM-1", symbol: "AAPL", assetType: "equity" } as const;
  const prepared = await prepareEntry(ctx, args);
  if (!prepared.ok || prepared.value.status !== "READY") throw new Error("entry not ready");
  await sendEntry(ctx, { ...args, intentId: prepared.value.intentId, confirmedQty: qty });
  await runSync(ctx);
  return ctx.sql
    .exec<{ id: string }>("SELECT id FROM positions WHERE symbol = 'AAPL' AND status != 'CLOSED'")
    .one().id;
}

/** Steps 0 to 3 of 10 contracts sell 3 + 2 + 1 + 1 = 70%, the test client's unlock share. */
async function sellUnlockShare(ctx: EntryContext, id: string) {
  for (const step of [0, 1, 2, 3] as const) {
    await exitPosition(ctx, { mode: "SIM", positionId: id, step });
    await runSync(ctx);
  }
}

const activate = (ctx: EntryContext, id: string, trailingPct: 10 | 20 = 10) =>
  activateTrailing(ctx, { mode: "SIM", positionId: id, trailingPct });
const reasons = (result: Awaited<ReturnType<typeof activate>>) =>
  result.ok && result.value.status === "BLOCKED" ? result.value.reasons : result;
const trailingRow = (ctx: EntryContext, id: string) =>
  ctx.sql
    .exec<{
      trailing_pct: number | null;
      trailing_peak: number | null;
      trailing_level: number | null;
    }>("SELECT trailing_pct, trailing_peak, trailing_level FROM positions WHERE id = ?", id)
    .one();
const exitsOfKind = (ctx: EntryContext, kind: string) =>
  ctx.sql
    .exec<{ qty: number; state: string }>("SELECT qty, state FROM intents WHERE kind = ?", kind)
    .toArray();

async function scenario(body: (ctx: EntryContext, sim: LocalSim, clock: Clock) => Promise<void>) {
  const clock: Clock = { now: IN_SESSION };
  const sim = newSim(clock);
  const client = await newClient();
  await inClient(client, clock, sim.adapter, (ctx) => body(ctx, sim, clock));
}

describe("trailing activation", { timeout: 30_000 }, () => {
  it("does not see another client's position id", async () => {
    const clock: Clock = { now: IN_SESSION };
    const sim = newSim(clock);
    const owner = await newClient();
    const other = await newClient();
    const id = await inClient(owner, clock, sim.adapter, async (ctx) => {
      const positionId = await openPosition(ctx, sim, 10);
      await sellUnlockShare(ctx, positionId);
      return positionId;
    });
    await inClient(other, clock, newSim(clock).adapter, async (ctx) => {
      expect(reasons(await activate(ctx, id))).toEqual(["POSITION_NOT_FOUND"]);
    });
    await inClient(owner, clock, sim.adapter, async (ctx) => {
      expect(trailingRow(ctx, id).trailing_pct).toBeNull();
    });
  });

  it("is refused before the unlock share is sold", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      expect(reasons(await activate(ctx, id))).toEqual(["NOT_ELIGIBLE"]);
      await exitPosition(ctx, { mode: "SIM", positionId: id, step: 0 });
      await runSync(ctx);
      expect(reasons(await activate(ctx, id))).toEqual(["NOT_ELIGIBLE"]);
      expect(trailingRow(ctx, id).trailing_pct).toBeNull();
    });
  });

  it("is refused while a sell is pending, and counts only confirmed sales", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await sellUnlockShare(ctx, id);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      await exitPosition(ctx, { mode: "SIM", positionId: id, step: 4 });
      expect(reasons(await activate(ctx, id))).toEqual(["EXIT_PENDING"]);
    });
  });

  it("starts the peak at a fresh bid and refuses a second activation", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await sellUnlockShare(ctx, id);
      sim.setQuote("AAPL", { bid: usd(250) });
      expect(await activate(ctx, id, 20)).toMatchObject({
        ok: true,
        value: { status: "ACTIVATED", trailingPct: 20, peak: usd(250), level: usd(200) },
      });
      expect(trailingRow(ctx, id)).toEqual({
        trailing_pct: 20,
        trailing_peak: usd(250),
        trailing_level: usd(200),
      });
      expect(reasons(await activate(ctx, id, 10))).toEqual(["ALREADY_ACTIVE"]);
    });
  });

  it("is refused without a live bid", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await sellUnlockShare(ctx, id);
      sim.inject({ kind: "quoteStale", symbol: "AAPL" });
      expect(reasons(await activate(ctx, id))).toEqual(["QUOTE_UNAVAILABLE"]);
      sim.inject({ kind: "quoteMissing", symbol: "AAPL" });
      expect(reasons(await activate(ctx, id))).toEqual(["QUOTE_UNAVAILABLE"]);
    });
  });
});

describe("trailing exit", { timeout: 30_000 }, () => {
  it("raises the level with the peak, never lowers it, and sells at the level", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await sellUnlockShare(ctx, id);
      sim.setQuote("AAPL", { bid: usd(250) });
      await activate(ctx, id, 10); // level 225
      sim.setQuote("AAPL", { bid: usd(300) });
      await runSync(ctx);
      expect(trailingRow(ctx, id)).toMatchObject({
        trailing_peak: usd(300),
        trailing_level: usd(270),
      });
      sim.setQuote("AAPL", { bid: usd(280) });
      await runSync(ctx);
      expect(trailingRow(ctx, id)).toMatchObject({
        trailing_peak: usd(300),
        trailing_level: usd(270),
      });
      expect(exitsOfKind(ctx, "trailing")).toEqual([]);

      sim.setQuote("AAPL", { bid: usd(270) });
      await runSync(ctx);
      expect(exitsOfKind(ctx, "trailing")).toEqual([{ qty: 3, state: "ACKNOWLEDGED" }]);
      await runSync(ctx);
      expect(
        ctx.sql.exec<{ status: string }>("SELECT status FROM positions WHERE id = ?", id).one(),
      ).toEqual({ status: "CLOSED" });
    });
  });

  it("waits out the cooldown after the broker rejected a trailing exit", async () => {
    await scenario(async (ctx, sim, clock) => {
      const id = await openPosition(ctx, sim, 10);
      await sellUnlockShare(ctx, id);
      sim.setQuote("AAPL", { bid: usd(250) });
      await activate(ctx, id, 10); // level 225
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      sim.inject({ kind: "rejectAfterAck" });
      sim.setQuote("AAPL", { bid: usd(225) });
      await runSync(ctx); // places the trailing exit
      await runSync(ctx); // the broker rejects it
      await runSync(ctx);
      expect(exitsOfKind(ctx, "trailing")).toEqual([{ qty: 3, state: "REJECTED" }]);
      clock.now += STOP_REJECTED_COOLDOWN_MS;
      await runSync(ctx);
      expect(exitsOfKind(ctx, "trailing").map((row) => row.state)).toEqual([
        "REJECTED",
        "ACKNOWLEDGED",
      ]);
      const events = ctx.sql
        .exec("SELECT id FROM events WHERE type = 'protection.trailing_triggered'")
        .toArray();
      expect(events.length).toBeGreaterThan(0);
    });
  });

  it("uses the stop while the trailing level is below it", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await sellUnlockShare(ctx, id);
      sim.setQuote("AAPL", { bid: usd(150) });
      await activate(ctx, id, 20); // level 120, stop level 140
      sim.setQuote("AAPL", { bid: usd(140) });
      await runSync(ctx);
      expect(exitsOfKind(ctx, "stop")).toHaveLength(1);
      expect(exitsOfKind(ctx, "trailing")).toEqual([]);
    });
  });

  it("never oversells when trailing races the stop and ALL OUT", async () => {
    await scenario(async (ctx, sim) => {
      const id = await openPosition(ctx, sim, 10);
      await sellUnlockShare(ctx, id);
      sim.setQuote("AAPL", { bid: usd(250) });
      await activate(ctx, id, 10);
      sim.setFill({ kind: "delayed", afterMs: 60_000 });
      sim.setQuote("AAPL", { bid: usd(100) }); // below both levels
      await Promise.all([
        runSync(ctx),
        exitPosition(ctx, { mode: "SIM", positionId: id, step: "ALL_OUT" }),
        exitPosition(ctx, { mode: "SIM", positionId: id, step: 4 }),
      ]);
      await runSync(ctx);
      const open = ctx.sql
        .exec<{ n: number }>(
          "SELECT COALESCE(SUM(qty), 0) AS n FROM intents WHERE kind != 'entry' AND state IN ('ACKNOWLEDGED', 'PARTIAL')",
        )
        .one().n;
      const position = ctx.sql
        .exec<{ sold_qty: number }>("SELECT sold_qty FROM positions WHERE id = ?", id)
        .one();
      expect(position.sold_qty + open).toBe(10);
    });
  });
});
