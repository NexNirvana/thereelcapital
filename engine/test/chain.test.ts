import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { BrokerAdapterShape } from "../src/broker/adapter.ts";
import { Rejected, Timeout } from "../src/broker/errors.ts";
import { optionChain } from "../src/chain.ts";
import { makeLocalSim } from "../src/broker/local-sim/sim.ts";

const usd = (dollars: number) => dollars * 1_000_000;
const NOW = Date.UTC(2026, 10, 4, 15, 0, 0);

function option(strike: number, right: "call" | "put", extra: { noChainMarket?: boolean } = {}) {
  return {
    symbol: `MSFT 261120${right === "call" ? "C" : "P"}${strike}`,
    assetType: "option" as const,
    bid: usd(3),
    ask: usd(3.2),
    ...extra,
    option: { underlying: "MSFT", expiration: "2026-11-20", strike: usd(strike), right },
  };
}

const sim = makeLocalSim({
  now: () => NOW,
  seed: "chain",
  accounts: [{ accountId: "SIM-1" }],
  symbols: [
    option(400, "call"),
    option(400, "put"),
    option(410, "call"),
    option(410, "put", { noChainMarket: true }),
  ],
});

async function inside<T>(
  broker: BrokerAdapterShape,
  body: (ctx: {
    sql: SqlStorage;
    storage: DurableObjectStorage;
    broker: BrokerAdapterShape;
    now: number;
  }) => Promise<T>,
) {
  const stub = env.COORDINATOR.getByName("chain-direct");
  return runInDurableObject(stub, (_i, state) =>
    body({ sql: state.storage.sql, storage: state.storage, broker, now: NOW - 20_000 }),
  );
}

describe("option chain", () => {
  it("lists every strike and leaves a side without a market as null, never zero", async () => {
    const result = await inside(sim.adapter, (ctx) =>
      optionChain({ ...ctx, stamp: () => NOW }, { underlying: "MSFT", expiration: "2026-11-20" }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        underlying: "MSFT",
        expiration: "2026-11-20",
        receivedAt: NOW,
        strikes: [
          {
            strike: usd(400),
            call: { symbol: "MSFT 261120C400", bid: usd(3), ask: usd(3.2) },
            put: { symbol: "MSFT 261120P400", bid: usd(3), ask: usd(3.2) },
          },
          {
            strike: usd(410),
            call: { symbol: "MSFT 261120C410", bid: usd(3), ask: usd(3.2) },
            put: null,
          },
        ],
      },
    });
  });

  it("answers NOT_FOUND for an unknown underlying and BROKER_UNAVAILABLE for a broker failure", async () => {
    const unknown = await inside(sim.adapter, (ctx) =>
      optionChain({ ...ctx, stamp: () => NOW }, { underlying: "ZZZZ", expiration: "2026-11-20" }),
    );
    expect(unknown).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const timedOut: BrokerAdapterShape = {
      ...sim.adapter,
      chainSnapshot: () => Effect.fail(new Timeout({ operation: "chainSnapshot" })),
    };
    const down = await inside(timedOut, (ctx) =>
      optionChain({ ...ctx, stamp: () => NOW }, { underlying: "MSFT", expiration: "2026-11-20" }),
    );
    expect(down).toMatchObject({ ok: false, code: "BROKER_UNAVAILABLE" });
  });

  it("tells the client to reconnect when the token lacks the options scope", async () => {
    const noScope: BrokerAdapterShape = {
      ...sim.adapter,
      chainSnapshot: () =>
        Effect.fail(
          new Rejected({
            operation: "chainSnapshot",
            code: "MISSING_SCOPE",
            reason: "Missing required scope.",
          }),
        ),
    };
    const result = await inside(noScope, (ctx) =>
      optionChain({ ...ctx, stamp: () => NOW }, { underlying: "MSFT", expiration: "2026-11-20" }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "RECONNECT_REQUIRED",
      message: expect.stringContaining("Reconectar"),
    });
  });
});

describe("option RPCs", () => {
  const stub = () => env.COORDINATOR.getByName("chain-rpc");

  it("serve the local simulation through the coordinator", async () => {
    const expirations = await stub().optionExpirations({ mode: "SIM", underlying: "MSFT" });
    expect(expirations).toMatchObject({ ok: true, value: { underlying: "MSFT" } });
    if (!expirations.ok) throw new Error("expected expirations");
    const [first] = expirations.value.expirations;
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const chain = await stub().optionChain({ mode: "SIM", underlying: "MSFT", expiration: first });
    if (!chain.ok) throw new Error("expected a chain");
    expect(chain.value.strikes.map((s) => s.strike)).toEqual([usd(395), usd(400), usd(405)]);
    // The 405 put is listed but has no market: it is null, not a zero price.
    expect(chain.value.strikes[2]).toMatchObject({ put: null, call: { bid: usd(2) } });

    const symbol = chain.value.strikes[1]?.call?.symbol ?? "";
    const contract = await stub().optionContract({ mode: "SIM", symbol });
    expect(contract).toEqual({
      ok: true,
      value: { symbol, underlying: "MSFT", expiration: first, strike: usd(400), right: "call" },
    });
  });

  it("refuses an equity symbol as a contract and an unknown underlying", async () => {
    expect(await stub().optionContract({ mode: "SIM", symbol: "MSFT" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await stub().optionExpirations({ mode: "SIM", underlying: "ZZZZ" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("decodes its input: lowercase tickers, bad dates and extra fields are refused", async () => {
    for (const input of [
      { mode: "SIM", underlying: "msft" },
      { mode: "SIM", underlying: "MSFT", url: "https://x" },
      { mode: "SIM", underlying: "../x" },
    ]) {
      expect(await stub().optionExpirations(input)).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(
      await stub().optionChain({ mode: "SIM", underlying: "MSFT", expiration: "next friday" }),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await stub().optionChain({ mode: "REAL", underlying: "MSFT", expiration: "2026-11-20" }),
    ).toMatchObject({ code: "MODE_NOT_SIM" });
  });
});
