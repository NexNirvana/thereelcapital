// `bun run test:e2e`: runs Playwright with ports and a state directory of its own, so several runs
// (CI shards on one host, agents in worktrees) can share a machine. Everything else about the run
// reads them from tests/e2e/ports.ts. Set E2E_PORT_BASE to choose the ports yourself.
import { rmSync } from "node:fs";
import { createServer } from "node:net";

const isFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    // No host: binds the wildcard address, which fails if anything holds the port on any interface.
    server.listen(port, () => server.close(() => resolve(true)));
  });

// Below Linux's ephemeral range (32768+), so an outgoing connection never owns a port picked here.
async function freePortBase(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 10_000 + Math.floor(Math.random() * 20_000);
    if ((await isFree(base)) && (await isFree(base + 1))) return base;
  }
  throw new Error("no free port pair found for the e2e run");
}

const portBase = Number(process.env.E2E_PORT_BASE ?? (await freePortBase()));
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65534)
  throw new Error(`E2E_PORT_BASE must be an integer from 1024 to 65534, got "${portBase}"`);
// Only a directory the runner chose is removed afterwards; one given in E2E_STATE_DIR is the caller's.
const ownsStateDir = process.env.E2E_STATE_DIR === undefined;
const stateDir = process.env.E2E_STATE_DIR ?? `.wrangler/e2e-${portBase}`;

const playwright = Bun.spawn(["node_modules/.bin/playwright", "test", ...process.argv.slice(2)], {
  env: { ...process.env, E2E_PORT_BASE: String(portBase), E2E_STATE_DIR: stateDir },
  stdio: ["inherit", "inherit", "inherit"],
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => playwright.kill(signal));

const code = await playwright.exited;
if (ownsStateDir) rmSync(stateDir, { recursive: true, force: true });
process.exit(code);
