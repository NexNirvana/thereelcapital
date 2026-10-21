// Builds the BrokerAdapter a client's Durable Object trades through. Production is always the
// TradeStation SIM adapter (its construction, request and order guards refuse anything else); the
// local simulation needs the explicit opt-in that `selectBroker` checks. There is no other path to a
// broker (CLAUDE.md, SIM only).

import type { BrokerAdapterShape } from "./adapter.ts";
import { makeLocalSim, type LocalSim, type LocalSimConfig } from "./local-sim/sim.ts";
import { selectBroker, type BrokerSettings } from "./select.ts";
import { makeTradeStationAdapter } from "../tradestation/adapter.ts";
import type { AccessTokenSource } from "../tradestation/http.ts";

export type BrokerResolution =
  | { readonly ok: true; readonly broker: BrokerAdapterShape }
  | { readonly ok: false; readonly reason: string };

/** One simulation per client, so a client's scripted quotes and orders never leak into another's. */
const localSims = new Map<string, LocalSim>();

const usd = (dollars: number) => dollars * 1_000_000;

const developmentConfig = (now: () => number, seed: string): LocalSimConfig => ({
  now,
  seed,
  accounts: [{ accountId: "SIM-1" }],
  symbols: [{ symbol: "MSFT", assetType: "equity", bid: usd(100), ask: usd(101) }],
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
    return { ok: true, broker: localSimFor(args.userId).adapter };
  }
  // The mode is fixed to SIM here and checked again by the transport, which also pins the base URL.
  const made = makeTradeStationAdapter({
    mode: "SIM",
    accessToken: args.accessToken,
    now: args.now,
  });
  return made.ok ? { ok: true, broker: made.adapter } : { ok: false, reason: made.reason };
}
