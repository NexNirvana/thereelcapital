// `bun run spike [step|all] [--confirm-sim-orders]`: observes TradeStation SIM behavior for issue
// #21 and saves sanitized samples. SIM only; see scripts/sim-spike/ and docs/tradestation-integration.md.
import { SpikeAbort } from "./sim-spike/client.ts";
import { main } from "./sim-spike/run.ts";

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  // Only our own aborts have messages that are safe to print.
  console.error(error instanceof SpikeAbort ? error.message : "Spike failed unexpectedly.");
  process.exit(1);
}
