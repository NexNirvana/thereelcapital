import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SYNC_RETRY_DELAY_MS } from "#lib/domain/config.ts";
import type { ClientCoordinator } from "../src/index.ts";
import type { BrokerAccount, BrokerAdapterShape } from "../src/broker/adapter.ts";
import { Unknown } from "../src/broker/errors.ts";
import { makeLocalSim } from "../src/broker/local-sim/sim.ts";
import { prepareEntry, sendEntry, type EntryContext } from "../src/entries.ts";
import { readRealListing } from "../src/overview.ts";
import { listRealAccounts, unbindRealAccounts } from "../src/real-accounts.ts";
import { runSync } from "../src/sync.ts";
import {
  IN_SESSION,
  inClient,
  newClient,
  newSim,
  type Client,
  type Clock,
} from "./sync-helpers.ts";

const account = (accountId: string, overrides: Partial<BrokerAccount> = {}): BrokerAccount => ({
  accountId,
  kind: "Margin",
  active: true,
  optionApprovalLevel: 0,
  label: accountId,
  ...overrides,
});

/** A broker whose account listing is scripted: the live host's answer. */
const listing = (clock: Clock, accounts: readonly BrokerAccount[]): BrokerAdapterShape => ({
  ...newSim(clock).adapter,
  accounts: () => Effect.succeed(accounts),
});

const realRows = (ctx: EntryContext) =>
  ctx.sql
    .exec<{ account_id: string }>(
      "SELECT account_id FROM broker_accounts WHERE mode = 'REAL' ORDER BY account_id",
    )
    .toArray()
    .map((row) => row.account_id);

const owner = async (accountId: string) =>
  (
    await env.DB.prepare("SELECT user_id FROM real_account_bindings WHERE account_id = ?")
      .bind(accountId)
      .first<{ user_id: string }>()
  )?.user_id;

/** Account ids unique to each test: the bindings table is shared by every test file's database. */
let n = 0;
const unique = (name: string) => `${name}-${++n}-${crypto.randomUUID().slice(0, 8)}`;

describe("REAL accounts", () => {
  it("stores only active Cash and Margin accounts SIM did not list, and binds them", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    const [live, cash, closed, futures] = [unique("L"), unique("C"), unique("X"), unique("F")];
    const broker = listing(clock, [
      account(live),
      account(cash, { kind: "Cash" }),
      account(closed, { active: false }),
      account(futures, { kind: "Futures" }),
      account("SIM-1"), // also listed by SIM: not a live account
    ]);
    await inClient(client, clock, broker, async (ctx) => {
      const result = await listRealAccounts(ctx, broker);
      expect(result).toEqual({ ok: true, stored: 2, skipped: 0 });
      expect(realRows(ctx)).toEqual([cash, live].sort());
    });
    expect(await owner(live)).toBe(client.userId);
    expect(await owner(closed)).toBeUndefined();
    expect(await owner("SIM-1")).toBeUndefined();
  });

  it("skips an account bound to another client and says so without naming it", async () => {
    const clock: Clock = { now: IN_SESSION };
    const [first, second] = [await newClient(), await newClient()];
    const shared = unique("S");
    const own = unique("O");
    const broker = listing(clock, [account(shared), account(own)]);
    await inClient(first, clock, broker, async (ctx) => {
      await listRealAccounts(ctx, listing(clock, [account(shared)]));
    });
    await inClient(second, clock, broker, async (ctx) => {
      expect(await listRealAccounts(ctx, broker)).toEqual({ ok: true, stored: 1, skipped: 1 });
      expect(realRows(ctx)).toEqual([own]);
      const logged = ctx.sql
        .exec("SELECT type, data_json FROM events WHERE mode = 'REAL'")
        .toArray();
      expect(JSON.stringify(logged)).toContain("bound_elsewhere");
      expect(JSON.stringify(logged)).not.toContain(shared);
      expect(JSON.stringify(logged)).not.toContain(first.userId);
      // The latest listing alone is the current outcome: it carries both counts.
      expect(readRealListing(ctx.sql)).toEqual({
        at: expect.any(Number),
        stored: 1,
        skipped: 1,
      });
      expect(
        ctx.sql
          .exec<{ data_json: string }>(
            "SELECT data_json FROM events WHERE mode = 'REAL' AND type = 'real_accounts.listed'",
          )
          .one().data_json,
      ).toBe('{"stored":1,"skipped":1}');
    });
    expect(await owner(shared)).toBe(first.userId);
  });

  it("reads no listing before the first one and zero skipped after a clean one", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    const broker = listing(clock, [account(unique("Z"))]);
    await inClient(client, clock, broker, async (ctx) => {
      expect(readRealListing(ctx.sql)).toBeNull();
      await listRealAccounts(ctx, broker);
      expect(readRealListing(ctx.sql)).toEqual({ at: expect.any(Number), stored: 1, skipped: 0 });
    });
  });

  it("gives a contested account to exactly one of two clients listing it at once", async () => {
    const clock: Clock = { now: IN_SESSION };
    const clients: Client[] = [await newClient(), await newClient(), await newClient()];
    const contested = unique("R");
    const broker = listing(clock, [account(contested)]);
    const outcomes = await Promise.all(
      clients.map((client) =>
        inClient(client, clock, broker, async (ctx) => {
          await listRealAccounts(ctx, broker);
          return realRows(ctx);
        }),
      ),
    );
    expect(outcomes.filter((rows) => rows.length === 1)).toHaveLength(1);
    const winner = clients[outcomes.findIndex((rows) => rows.length === 1)];
    expect(await owner(contested)).toBe(winner?.userId);
  });

  it("keeps the stored accounts when the live listing fails", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    const kept = unique("K");
    const ok = listing(clock, [account(kept)]);
    const failing: BrokerAdapterShape = {
      ...ok,
      accounts: () => Effect.fail(new Unknown({ operation: "accounts", detail: "scripted" })),
    };
    await inClient(client, clock, ok, async (ctx) => {
      await listRealAccounts(ctx, ok);
      expect(await listRealAccounts(ctx, failing)).toMatchObject({ ok: false });
      expect(realRows(ctx)).toEqual([kept]);
    });
  });

  it("frees the accounts when the client disconnects through the RPC", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    const freed = unique("D");
    const broker = listing(clock, [account(freed)]);
    await inClient(client, clock, broker, (ctx) => listRealAccounts(ctx, broker));
    expect(await owner(freed)).toBe(client.userId);
    // No connection row: the disconnect has nothing to revoke at TradeStation, only local state to clear.
    await env.DB.prepare("DELETE FROM broker_connection WHERE user_id = ?")
      .bind(client.userId)
      .run();
    expect((await client.stub.disconnect({ mode: "SIM" })).ok).toBe(true);
    expect(await owner(freed)).toBeUndefined();
  });

  it("frees the accounts of a client that disconnects", async () => {
    const clock: Clock = { now: IN_SESSION };
    const client = await newClient();
    const freed = unique("U");
    const broker = listing(clock, [account(freed)]);
    await inClient(client, clock, broker, (ctx) => listRealAccounts(ctx, broker));
    expect(await owner(freed)).toBe(client.userId);
    await unbindRealAccounts(env.DB, client.userId);
    expect(await owner(freed)).toBeUndefined();
  });
});

describe("a REAL pass and a SIM pass", () => {
  const target = { mode: "SIM", accountId: "SIM-1", symbol: "AAPL", assetType: "equity" } as const;
  const rows = (ctx: EntryContext, mode: "SIM" | "REAL") =>
    JSON.stringify([
      ctx.sql.exec("SELECT * FROM positions WHERE mode = ? ORDER BY id", mode).toArray(),
      ctx.sql.exec("SELECT * FROM intents WHERE mode = ? ORDER BY id", mode).toArray(),
    ]);

  it("interleave without either writing the other mode's rows", async () => {
    const clock: Clock = { now: IN_SESSION };
    const simBroker = newSim(clock);
    // The live host knows nothing of the position below, so its pass closes it: REAL's own write.
    const realBroker = makeLocalSim({
      now: () => clock.now,
      seed: "real",
      accounts: [{ accountId: "LIVE-1" }],
      symbols: [],
    });
    const client = await newClient();
    await inClient(client, clock, simBroker.adapter, async (simCtx) => {
      const realCtx: EntryContext = { ...simCtx, mode: "REAL", broker: realBroker.adapter };
      const prepared = await prepareEntry(simCtx, target);
      if (!prepared.ok || prepared.value.status !== "READY") throw new Error("not ready");
      await sendEntry(simCtx, {
        ...target,
        intentId: prepared.value.intentId,
        confirmedQty: prepared.value.qty,
      });
      simCtx.sql.exec(
        "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('REAL', 'LIVE-1', 'Margin')",
      );
      simCtx.sql.exec(
        `INSERT INTO positions (id, mode, account_id, symbol, original_qty, avg_entry_price, stop_pct,
           trailing_unlock_pct, protection_state, status, opened_on)
         VALUES ('real-1', 'REAL', 'LIVE-1', 'MSFT', 10, 1, 30, 70, 'unverified', 'OPEN', '2026-11-04')`,
      );
      const realBefore = rows(simCtx, "REAL");
      const simBefore = rows(simCtx, "SIM");

      await runSync(simCtx);
      expect(rows(simCtx, "REAL")).toBe(realBefore);
      expect(rows(simCtx, "SIM")).not.toBe(simBefore);

      const simAfter = rows(simCtx, "SIM");
      await Promise.all([runSync(simCtx), runSync(realCtx)]);
      expect(rows(simCtx, "SIM")).toBe(simAfter);
      expect(rows(simCtx, "REAL")).not.toBe(realBefore);
      expect(simCtx.sql.exec("SELECT status FROM positions WHERE id = 'real-1'").one()).toEqual({
        status: "CLOSED",
      });
    });
  });
});

describe("the REAL listing retry", () => {
  /** A REAL-enabled idle client whose live listing is scripted; time moves only by `setSystemTime`. */
  async function withListing(
    run: (t: {
      instance: ClientCoordinator;
      alarm: () => Promise<number | null>;
      request: () => Promise<number | null>;
      pass: () => Promise<void>;
      script: {
        failing: boolean;
        gate: Promise<void> | null;
        started: () => void;
        sim: ReturnType<typeof newSim> | null;
      };
      live: string;
      realRows: () => string[];
    }) => Promise<void>,
  ) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(IN_SESSION);
    try {
      const clock: Clock = { now: IN_SESSION };
      const client = await newClient();
      await env.DB.prepare("UPDATE client_settings SET real_trading_enabled = 1 WHERE user_id = ?")
        .bind(client.userId)
        .run();
      const live = unique("W");
      const script = {
        failing: true,
        gate: null as Promise<void> | null,
        started: () => {},
        sim: null as ReturnType<typeof newSim> | null,
      };
      // The live host knows its own account, so the REAL pass that follows the listing works.
      const liveSim = makeLocalSim({
        now: () => clock.now,
        seed: "live",
        accounts: [{ accountId: live }],
        symbols: [{ symbol: "AAPL", assetType: "equity", bid: 199_000_000, ask: 200_000_000 }],
      });
      const simBroker = newSim(clock);
      script.sim = simBroker;
      const broker: BrokerAdapterShape = {
        ...liveSim.adapter,
        accounts: () =>
          Effect.promise(async () => {
            script.started();
            await script.gate;
          }).pipe(
            Effect.flatMap(() =>
              script.failing
                ? Effect.fail(new Unknown({ operation: "accounts", detail: "live host down" }))
                : Effect.succeed([account(live)]),
            ),
          ),
      };
      await runInDurableObject(client.stub, async (instance: ClientCoordinator, state) => {
        // The test deployment is closed: stand in for the open switch on its reads.
        const refresh = instance["refreshModeLocks"].bind(instance);
        instance["refreshModeLocks"] = () => refresh(true);
        instance["brokerFor"] = (ctx) => (ctx.mode === "REAL" ? broker : simBroker.adapter);
        await state.storage.deleteAlarm();
        await run({
          instance,
          // The scheduler's due time (storage KV), not the runtime's alarm: workerd runs alarms on
          // the real clock and reports a past alarm as "now", so for the fixed IN_SESSION instant
          // getAlarm() grows with real elapsed time once that instant has passed.
          alarm: async () => {
            if ((await state.storage.getAlarm()) === null) return null;
            const due = ["refresh", "sync"].flatMap((task) => {
              const at = state.storage.kv.get<number>(`alarm_due:${task}`);
              return at === undefined ? [] : [at];
            });
            return Math.min(...due);
          },
          request: async () => {
            await state.storage.deleteAlarm();
            await instance.connection({ mode: "SIM" });
            return state.storage.getAlarm();
          },
          pass: async () => {
            await state.storage.deleteAlarm();
            await instance["runTask"]("sync");
          },
          script,
          live,
          realRows: () =>
            state.storage.sql
              .exec<{ account_id: string }>(
                "SELECT account_id FROM broker_accounts WHERE mode = 'REAL'",
              )
              .toArray()
              .map((row) => row.account_id),
        });
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("keeps the sync scheduled within the retry delay after a failed listing", async () => {
    await withListing(async ({ alarm, pass, realRows }) => {
      await pass();
      const due = await alarm();
      expect(due).not.toBeNull();
      expect((due ?? 0) - IN_SESSION).toBeLessThanOrEqual(SYNC_RETRY_DELAY_MS);
      expect(realRows()).toEqual([]);
    });
  });

  it("retries when a request arrives while the pass awaits the listing", async () => {
    await withListing(async ({ alarm, request, pass, script, live, realRows }) => {
      let release: () => void = () => {};
      script.gate = new Promise<void>((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (script.started = resolve));
      const running = pass();
      await started;
      await request(); // the pass has not finished: this wake-up is overwritten by its schedule
      release();
      await running;
      expect(await alarm()).not.toBeNull();
      script.gate = null;
      script.failing = false;
      vi.setSystemTime(IN_SESSION + SYNC_RETRY_DELAY_MS);
      await pass();
      expect(realRows()).toEqual([live]);
    });
  });

  it("wakes a sync from a request only once the retry delay has passed", async () => {
    await withListing(async ({ request, pass }) => {
      await pass();
      vi.setSystemTime(IN_SESSION + SYNC_RETRY_DELAY_MS - 1);
      expect(await request()).toBeNull();
      vi.setSystemTime(IN_SESSION + SYNC_RETRY_DELAY_MS);
      expect(await request()).not.toBeNull();
    });
  });

  it("stops rescheduling once the listing succeeded", async () => {
    await withListing(async ({ alarm, request, pass, script, live, realRows }) => {
      script.failing = false;
      await pass();
      expect(realRows()).toEqual([live]);
      expect(await alarm()).toBeNull();
      vi.setSystemTime(IN_SESSION + 10 * SYNC_RETRY_DELAY_MS);
      expect(await request()).toBeNull();
    });
  });

  it("keeps a rate-limit wait longer than the retry delay", async () => {
    await withListing(async ({ alarm, pass, script }) => {
      script.sim?.inject({
        kind: "rateLimited",
        operation: "positions",
        retryAfterMs: 5 * SYNC_RETRY_DELAY_MS,
      });
      await pass();
      expect((await alarm()) ?? 0).toBeGreaterThanOrEqual(IN_SESSION + 5 * SYNC_RETRY_DELAY_MS);
    });
  });

  it("forces no tick for a flag-on client with no connection", async () => {
    await withListing(async ({ instance, alarm, request, pass }) => {
      instance["ctx"].storage.sql.exec("DELETE FROM broker_accounts");
      await pass();
      expect(await alarm()).toBeNull();
      expect(await request()).toBeNull();
    });
  });
});
