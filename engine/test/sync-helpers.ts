// Shared setup for the sync and reconciliation tests: a connected client, a local simulation with a
// clock the test moves, and a snapshot read through the BrokerAdapter like the sync loop does.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import type { BrokerAdapterShape, BrokerOrder } from "../src/broker/adapter.ts";
import { makeLocalSim, type LocalSim } from "../src/broker/local-sim/sim.ts";
import { createCipher } from "../src/crypto.ts";
import type { EntryContext } from "../src/entries.ts";
import type { BrokerSnapshot, ProtectionSettings } from "../src/reconcile.ts";
import { TokenRefresher } from "../src/refresh.ts";

// Wednesday 2026-11-04 10:00 in New York: inside the regular session of NYSE and CBOE options.
export const IN_SESSION = Date.UTC(2026, 10, 4, 15, 0, 0);
export const usd = (dollars: number) => dollars * 1_000_000;
export const ACCOUNTS = ["SIM-1", "SIM-2"] as const;
export const PROTECTION: ProtectionSettings = { stopPct: 30, trailingUnlockPct: 70 };

export interface Clock {
  now: number;
}

export function newSim(
  clock: Clock,
  symbols: readonly string[] = ["AAPL", "MSFT", "NVDA"],
): LocalSim {
  return makeLocalSim({
    now: () => clock.now,
    seed: "sync",
    accounts: ACCOUNTS.map((accountId) => ({ accountId })),
    symbols: symbols.map((symbol) => ({
      symbol,
      assetType: "equity" as const,
      bid: usd(199),
      ask: usd(200),
    })),
  });
}

let counter = 0;

export async function newClient() {
  const userId = `sync-user-${++counter}`;
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Test', ?, 1, 0, 0)`,
  )
    .bind(userId, `${userId}@example.test`)
    .run();
  await env.DB.prepare(
    "INSERT INTO client_settings (user_id, size_usd, stop_pct, trailing_unlock_pct, updated_at) VALUES (?, 20000, 30, 70, 0)",
  )
    .bind(userId)
    .run();
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
    for (const accountId of ACCOUNTS) {
      state.storage.sql.exec(
        "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', ?, 'Margin')",
        accountId,
      );
    }
  });
  return { userId, stub };
}

export type Client = Awaited<ReturnType<typeof newClient>>;

/** Runs `body` inside the client's Durable Object with an entry context over `broker`. */
export function inClient<T>(
  client: Client,
  clock: Clock,
  broker: BrokerAdapterShape,
  body: (ctx: EntryContext, state: DurableObjectState) => Promise<T> | T,
): Promise<T> {
  return runInDurableObject(client.stub, async (_instance, state) => {
    const tokens = new TokenRefresher({
      sql: state.storage.sql,
      storage: state.storage,
      db: env.DB,
      userId: client.userId,
      cipher: () => createCipher(env.CREDENTIALS_KEY),
      clock: () => clock.now,
      retryDelayMs: 0,
    });
    const ctx: EntryContext = {
      sql: state.storage.sql,
      storage: state.storage,
      db: env.DB,
      userId: client.userId,
      get now() {
        return clock.now;
      },
      cipher: () => createCipher(env.CREDENTIALS_KEY),
      tokens,
      broker,
    };
    return body(ctx, state);
  });
}

export const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

export async function readSnapshot(broker: BrokerAdapterShape): Promise<BrokerSnapshot> {
  const accounts = [...ACCOUNTS];
  return {
    orders: await run(broker.orders(accounts)),
    historical: [],
    positions: await run(broker.positions(accounts)),
    details: new Map(),
  };
}

/** The adapter as TradeStation behaves per the spec: its orders listing never echoes OrderConfirmID. */
export function withoutConfirmIds(broker: BrokerAdapterShape): BrokerAdapterShape {
  const strip = (orders: ReadonlyArray<BrokerOrder>) =>
    orders.map((order) => ({ ...order, orderConfirmId: null }));
  return {
    ...broker,
    orders: (ids) => Effect.map(broker.orders(ids), strip),
    historicalOrders: (ids, since) => Effect.map(broker.historicalOrders(ids, since), strip),
  };
}
