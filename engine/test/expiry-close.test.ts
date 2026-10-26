// D45: an option still open on its expiration day is sold whole at MARKET 15 minutes before the
// close, through the engine-held stop's exit path. Local simulation only.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeLocalSim, type LocalSim } from "../src/broker/local-sim/sim.ts";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { runSync } from "../src/sync.ts";
import { ACCOUNTS, IN_SESSION, inClient, newClient, usd, type Clock } from "./sync-helpers.ts";

const OPTION = "MSFT 261120C400";
const EXPIRATION = "2026-11-20";
// 15:44:59 and 15:45:00 ET (UTC-5) on the expiration day.
const JUST_BEFORE = Date.UTC(2026, 10, 20, 20, 44, 59);
const AT_LEAD = Date.UTC(2026, 10, 20, 20, 45, 0);

function optionSim(clock: Clock): LocalSim {
  return makeLocalSim({
    now: () => clock.now,
    seed: "expiry",
    accounts: ACCOUNTS.map((accountId) => ({ accountId })),
    symbols: [
      {
        symbol: OPTION,
        assetType: "option",
        bid: usd(3.9),
        ask: usd(4),
        option: { underlying: "MSFT", expiration: EXPIRATION, strike: usd(400), right: "call" },
      },
    ],
  });
}

async function openOption(ctx: EntryContext, sim: LocalSim): Promise<number> {
  await env.DB.prepare("UPDATE client_settings SET size_usd = ? WHERE user_id = ?")
    .bind(20_000, ctx.userId)
    .run();
  sim.setFill({ kind: "instant" });
  const args = { mode: "SIM", accountId: "SIM-1", symbol: OPTION, assetType: "option" } as const;
  const prepared = await prepareEntry(ctx, args);
  if (!prepared.ok || prepared.value.status !== "READY") throw new Error("entry not ready");
  await sendEntry(ctx, {
    ...args,
    intentId: prepared.value.intentId,
    confirmedQty: prepared.value.qty,
  });
  await runSync(ctx);
  return ctx.sql
    .exec<{ original_qty: number; expiry: string }>(
      "SELECT original_qty, expiry FROM positions WHERE symbol = ? AND status != 'CLOSED'",
      OPTION,
    )
    .one().original_qty;
}

const closes = (ctx: EntryContext) =>
  ctx.sql
    .exec<{ qty: number; trade_action: string }>(
      "SELECT qty, trade_action FROM intents WHERE kind = 'stop' ORDER BY created_at, id",
    )
    .toArray();
const events = (ctx: EntryContext, name: string) =>
  ctx.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = ?", name).one().n;

async function scenario(
  body: (ctx: EntryContext, sim: LocalSim, clock: Clock, qty: number) => Promise<void>,
) {
  const clock: Clock = { now: IN_SESSION };
  const sim = optionSim(clock);
  const client = await newClient();
  await inClient(client, clock, sim.adapter, async (ctx) => {
    const qty = await openOption(ctx, sim);
    await body(ctx, sim, clock, qty);
  });
}

describe("option closed on its expiration day", { timeout: 30_000 }, () => {
  it("sells the whole remaining quantity at the lead, not a second before", async () => {
    await scenario(async (ctx, sim, clock, qty) => {
      clock.now = JUST_BEFORE;
      sim.setQuote(OPTION, { bid: usd(3.9) });
      await runSync(ctx);
      expect(closes(ctx)).toEqual([]);

      clock.now = AT_LEAD;
      sim.setQuote(OPTION, { bid: usd(3.9) });
      await runSync(ctx);
      expect(closes(ctx)).toEqual([{ qty, trade_action: "SELLTOCLOSE" }]);
      expect(events(ctx, "protection.expiry_triggered")).toBe(1);
    });
  });

  it("fires once across sync ticks and concurrent passes", async () => {
    await scenario(async (ctx, sim, clock) => {
      clock.now = AT_LEAD;
      sim.setQuote(OPTION, { bid: usd(3.9) });
      await Promise.all([runSync(ctx), runSync(ctx), runSync(ctx)]);
      await runSync(ctx);
      await runSync(ctx);
      expect(closes(ctx)).toHaveLength(1);
    });
  });

  it("is an exit: the entry limits do not block it and no counter moves", async () => {
    await scenario(async (ctx, sim, clock) => {
      ctx.sql.exec("UPDATE entry_counters SET consumed = 3");
      const before = ctx.sql.exec("SELECT consumed, reserved FROM entry_counters").toArray();
      clock.now = AT_LEAD;
      sim.setQuote(OPTION, { bid: usd(3.9) });
      await runSync(ctx);
      expect(closes(ctx)).toHaveLength(1);
      expect(ctx.sql.exec("SELECT consumed, reserved FROM entry_counters").toArray()).toEqual(
        before,
      );
    });
  });

  it("does not sell blind without a fresh bid: the position stays unverified and says so once", async () => {
    await scenario(async (ctx, sim, clock) => {
      clock.now = AT_LEAD;
      sim.setQuote(OPTION, { bid: 0 });
      await runSync(ctx);
      await runSync(ctx);
      expect(closes(ctx)).toEqual([]);
      expect(events(ctx, "protection.expiry_close_skipped")).toBe(1);
    });
  });

  it("records the close as a stop even while trailing is active", async () => {
    await scenario(async (ctx, sim, clock) => {
      // Trailing level above the stop level, bid above the trailing level: only the clock fires.
      ctx.sql.exec(
        "UPDATE positions SET trailing_pct = 10, trailing_peak = ?, trailing_level = ? WHERE status != 'CLOSED'",
        usd(4),
        usd(3.6),
      );
      clock.now = AT_LEAD;
      sim.setQuote(OPTION, { bid: usd(3.9) });
      await runSync(ctx);
      expect(closes(ctx)).toHaveLength(1);
      expect(ctx.sql.exec("SELECT kind FROM intents WHERE kind = 'trailing'").toArray()).toEqual(
        [],
      );
    });
  });

  it("leaves a position alone on other days", async () => {
    await scenario(async (ctx, sim, clock) => {
      clock.now = Date.UTC(2026, 10, 19, 20, 50, 0);
      sim.setQuote(OPTION, { bid: usd(3.9) });
      await runSync(ctx);
      expect(closes(ctx)).toEqual([]);
    });
  });
});
