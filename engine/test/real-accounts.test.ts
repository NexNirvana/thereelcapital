import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { BrokerAccount, BrokerAdapterShape } from "../src/broker/adapter.ts";
import { Unknown } from "../src/broker/errors.ts";
import type { EntryContext } from "../src/entries.ts";
import { listRealAccounts, unbindRealAccounts } from "../src/real-accounts.ts";
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
    });
    expect(await owner(shared)).toBe(first.userId);
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
