import { describe, expect, it } from "vitest";
import { scenarioSymbols, withScenarios } from "../src/broker/local-sim/scenarios.ts";
import { ACCOUNT, buy, newSim, run, sell } from "./broker-fixtures.ts";

describe("scripted symbols", () => {
  it("HOLD buys at once and leaves its exit working however long it waits", async () => {
    const { sim, clock } = newSim({ symbols: scenarioSymbols() });
    const adapter = withScenarios(sim);
    const hold = (request: ReturnType<typeof buy>) => ({ ...request, symbol: "HOLD" });

    await run(adapter.placeOrder(hold(buy("entry", 10))));
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 10 }]);

    const { orderId } = await run(adapter.placeOrder(hold(sell("exit", 4))));
    clock.at += 365 * 24 * 3_600_000;
    expect(await run(adapter.orders([ACCOUNT]))).toMatchObject([
      { status: "FILLED" },
      { status: "ACKNOWLEDGED" },
    ]);

    await run(adapter.cancelOrder(ACCOUNT, orderId));
    expect(await run(adapter.positions([ACCOUNT]))).toMatchObject([{ quantity: 10 }]);
  });
});
