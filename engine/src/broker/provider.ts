// Builds the BrokerAdapter a client's Durable Object trades through. Production is always the
// TradeStation SIM adapter (its construction, request and order guards refuse anything else); the
// local simulation needs the explicit opt-in that `selectBroker` checks. There is no other path to a
// broker (CLAUDE.md, SIM only).

import type { BrokerAdapterShape } from "./adapter.ts";
import { scenarioSymbols, withScenarios } from "./local-sim/scenarios.ts";
import {
  makeLocalSim,
  type LocalSim,
  type LocalSimConfig,
  type SimSymbol,
} from "./local-sim/sim.ts";
import { selectBroker, type BrokerSettings } from "./select.ts";
import { makeTradeStationAdapter } from "../tradestation/adapter.ts";
import type { AccessTokenSource } from "../tradestation/http.ts";

export type BrokerResolution =
  | { readonly ok: true; readonly broker: BrokerAdapterShape }
  | { readonly ok: false; readonly reason: string };

/** One simulation per client, so a client's scripted quotes and orders never leak into another's. */
const localSims = new Map<string, LocalSim>();

const usd = (dollars: number) => dollars * 1_000_000;

/** The Fridays at least two weeks out: the dev chain is always in the future, with no dates kept in the repo. */
function developmentExpirations(now: number): ReadonlyArray<Date> {
  const first = new Date(now + 14 * 24 * 60 * 60 * 1000);
  first.setUTCDate(first.getUTCDate() + ((5 - first.getUTCDay() + 7) % 7));
  return [first, new Date(first.getTime() + 7 * 24 * 60 * 60 * 1000)];
}

/**
 * MSFT options: 100, 105 and 395 to 405 calls and puts, the 405 put listed but with no market. The
 * first two sit around the simulated MSFT price (100 / 101), so a screen has a price to draw.
 */
function developmentOptions(now: number): ReadonlyArray<SimSymbol> {
  const two = (value: number) => String(value).padStart(2, "0");
  return developmentExpirations(now).flatMap((date) =>
    [100, 105, 395, 400, 405].flatMap((strike) =>
      (["call", "put"] as const).map((right) => {
        const yymmdd = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`;
        // The near strikes are priced from the simulated MSFT (101), the far ones from 405 / 395.
        const near = strike < 200;
        const premium =
          right === "call"
            ? usd(Math.max((near ? 101 : 405) - strike, 0) + 2)
            : usd(Math.max(strike - (near ? 101 : 395), 0) + 2);
        return {
          symbol: `MSFT ${yymmdd}${right === "call" ? "C" : "P"}${strike}`,
          assetType: "option" as const,
          bid: premium,
          ask: premium + usd(0.1),
          noChainMarket: strike === 405 && right === "put",
          option: {
            underlying: "MSFT",
            expiration: date.toISOString().slice(0, 10),
            strike: usd(strike),
            right,
          },
        };
      }),
    ),
  );
}

const developmentConfig = (now: () => number, seed: string): LocalSimConfig => ({
  now,
  seed,
  accounts: [{ accountId: "SIM-1" }],
  symbols: [
    { symbol: "MSFT", assetType: "equity", bid: usd(100), ask: usd(101) },
    ...developmentOptions(now()),
    ...scenarioSymbols(),
  ],
});

/**
 * The simulation of one client. A test passes `config` to script it; the first call fixes it, and
 * `reset` replaces it. Only reachable through `resolveBroker` after `selectBroker` allowed it.
 */
export function localSimFor(
  userId: string,
  config?: LocalSimConfig,
  options: { reset?: boolean } = {},
): LocalSim {
  const existing = localSims.get(userId);
  if (existing !== undefined && options.reset !== true) return existing;
  const created = makeLocalSim(config ?? developmentConfig(Date.now, userId));
  localSims.set(userId, created);
  return created;
}

export function resolveBroker(args: {
  readonly settings: BrokerSettings;
  readonly userId: string;
  readonly accessToken: AccessTokenSource;
  readonly now: () => number;
}): BrokerResolution {
  const choice = selectBroker(args.settings);
  if (!choice.ok) return { ok: false, reason: choice.reason };
  if (choice.broker === "local-sim") {
    return { ok: true, broker: withScenarios(localSimFor(args.userId)) };
  }
  // The mode is fixed to SIM here and checked again by the transport, which also pins the base URL.
  const made = makeTradeStationAdapter({
    mode: "SIM",
    accessToken: args.accessToken,
    now: args.now,
  });
  return made.ok ? { ok: true, broker: made.adapter } : { ok: false, reason: made.reason };
}
