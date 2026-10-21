import { Effect } from "effect";
import type { OrderRequest } from "../src/broker/adapter.ts";
import type { BrokerError } from "../src/broker/errors.ts";
import { makeLocalSim, type LocalSimConfig } from "../src/broker/local-sim/sim.ts";

export const ACCOUNT = "SIM-1";
export const OTHER_ACCOUNT = "SIM-2";
export const T0 = 1_800_000_000_000;

const usd = (dollars: number) => dollars * 1_000_000;

/** A simulation with a controllable clock, one equity and a small option chain. */
export function newSim(overrides: Partial<LocalSimConfig> = {}) {
  const clock = { at: T0 };
  const sim = makeLocalSim({
    now: () => clock.at,
    seed: "t",
    accounts: [{ accountId: ACCOUNT }, { accountId: OTHER_ACCOUNT, kind: "Cash" }],
    symbols: [
      { symbol: "MSFT", assetType: "equity", bid: usd(100), ask: usd(101), last: usd(100.5) },
      {
        symbol: "MSFT 261120C400",
        assetType: "option",
        bid: usd(3),
        ask: usd(3.2),
        option: { underlying: "MSFT", expiration: "2026-11-20", strike: usd(400), right: "call" },
      },
      {
        symbol: "MSFT 261120P400",
        assetType: "option",
        bid: usd(2),
        ask: usd(2.1),
        option: { underlying: "MSFT", expiration: "2026-11-20", strike: usd(400), right: "put" },
      },
      {
        symbol: "MSFT 261218C410",
        assetType: "option",
        bid: usd(4),
        ask: usd(4.2),
        option: { underlying: "MSFT", expiration: "2026-12-18", strike: usd(410), right: "call" },
      },
    ],
    ...overrides,
  });
  return { sim, adapter: sim.adapter, clock };
}

export function buy(orderConfirmId: string, quantity = 10): OrderRequest {
  return {
    accountId: ACCOUNT,
    symbol: "MSFT",
    assetType: "equity",
    tradeAction: "BUY",
    quantity,
    orderConfirmId,
  };
}

export function sell(orderConfirmId: string, quantity: number): OrderRequest {
  return { ...buy(orderConfirmId, quantity), tradeAction: "SELL" };
}

export const run = <A>(effect: Effect.Effect<A, BrokerError>) => Effect.runPromise(effect);

/** The failure of an effect that must fail. */
export const failureOf = <A>(effect: Effect.Effect<A, BrokerError>) =>
  Effect.runPromise(Effect.flip(effect));
