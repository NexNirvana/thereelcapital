// The one place the e2e run's ports and local state directory come from. `bun run test:e2e`
// (scripts/e2e.ts) picks free ones per run and passes them in the environment, so runs on one
// machine never collide; started by hand, playwright falls back to these defaults.
const portBase = Number(process.env.E2E_PORT_BASE ?? 8790);

export const webPort = portBase;
export const inspectorPort = portBase + 1;
export const origin = `http://localhost:${webPort}`;
// Where wrangler persists D1 and Durable Object state, so a run never shares files with another.
export const stateDir = process.env.E2E_STATE_DIR ?? ".wrangler/state";
