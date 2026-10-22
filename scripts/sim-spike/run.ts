// Wires the spike together: arguments, credentials, login, steps, samples and the report.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { isRegularSession, sessionDate } from "#lib/domain/calendar.ts";
import { SimClient, SpikeAbort, type SampleSink } from "./client.ts";
import { Findings, renderReport } from "./findings.ts";
import { DEFAULT_PORT, TokenSession, callbackUrl } from "./oauth.ts";
import { Redactor } from "./redact.ts";
import { ORDER_STEPS, STEPS, type StepContext } from "./steps.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
const SAMPLES_DIR = join(REPO_ROOT, "engine/test/fixtures/sim");
const SCRATCH_DIR = join(REPO_ROOT, ".spike");

export interface Options {
  readonly steps: readonly string[];
  readonly confirmSimOrders: boolean;
  readonly port: number;
  readonly symbol: string;
  readonly account: string | undefined;
}

const stepNames = STEPS.map(([name]) => name);

export function parseArgs(argv: readonly string[]): Options | string {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let confirmSimOrders = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--confirm-sim-orders") confirmSimOrders = true;
    else if (arg === "--port" || arg === "--symbol" || arg === "--account") {
      const value = argv[i + 1];
      if (value === undefined) return `${arg} needs a value`;
      flags.set(arg, value);
      i += 1;
    } else if (arg.startsWith("--")) return `unknown option ${arg}`;
    else positional.push(arg);
  }
  const unknown = positional.filter((name) => name !== "all" && !stepNames.includes(name));
  if (unknown.length > 0)
    return `unknown step ${unknown.join(", ")}; steps: ${stepNames.join(", ")}`;
  const port = Number(flags.get("--port") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "invalid --port";
  const symbol = (flags.get("--symbol") ?? "F").toUpperCase();
  if (!/^[A-Z.]{1,6}$/.test(symbol)) return "invalid --symbol";
  const all = positional.length === 0 || positional.includes("all");
  return {
    steps: all ? stepNames : stepNames.filter((name) => positional.includes(name)),
    confirmSimOrders,
    port,
    symbol,
    account: flags.get("--account"),
  };
}

/** Reads the credentials from the repo `.env` (or the main clone's, for a git worktree). */
function loadCredentials(): { clientId: string; clientSecret: string } {
  // In a git worktree the git-ignored .env lives next to the main clone's .git directory.
  const common = Bun.spawnSync([
    "git",
    "-C",
    REPO_ROOT,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const mainClone = dirname(common.stdout.toString().trim());
  const candidates = [join(REPO_ROOT, ".env"), join(mainClone, ".env")];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) throw new SpikeAbort("No .env found in the repo root.");
  const env = parseEnv(readFileSync(path, "utf8"));
  const clientId = env.TRADINGSTATION_API_KEY;
  const clientSecret = env.TRADINGSTATION_API_SECRET;
  if (!clientId || !clientSecret) {
    throw new SpikeAbort("TRADINGSTATION_API_KEY / TRADINGSTATION_API_SECRET missing in .env.");
  }
  return { clientId, clientSecret };
}

function fileSink(redactor: Redactor): SampleSink {
  return {
    save(step, name, sample) {
      const dir = join(SAMPLES_DIR, step);
      mkdirSync(dir, { recursive: true });
      // Redacted again on the way out: the last line of defense for anything a caller missed.
      const clean = redactor.json(sample);
      writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(clean, null, 2)}\n`);
    },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") {
    console.error(
      `${options}\nusage: bun run spike [step|all] [--confirm-sim-orders] [--port N] [--symbol F] [--account ID]`,
    );
    return 2;
  }
  const now = () => new Date();
  const wantsOrders = options.steps.some((name) => ORDER_STEPS.has(name));
  if (wantsOrders) {
    if (!options.confirmSimOrders) {
      console.error("These steps place tiny SIM orders. Re-run with --confirm-sim-orders.");
      return 2;
    }
    for (const kind of ["equity", "option"] as const) {
      const session = isRegularSession({ kind }, now());
      if (!session.open) {
        console.error(
          `Refusing to place orders: ${kind} ${session.reason}. Run during the regular session.`,
        );
        return 2;
      }
    }
  }

  const credentials = loadCredentials();
  const redactor = new Redactor();
  // The client id is not secret (it is in the authorize URL); samples still mask it by key name.
  redactor.addSecret(credentials.clientSecret);
  const log = (line: string) => console.log(redactor.text(line));
  const findings = new Findings(redactor, log);

  const client: SimClient = new SimClient({
    fetchFn: fetch,
    clock: { now },
    redactor,
    samples: fileSink(redactor),
    ordersEnabled: options.confirmSimOrders,
    accessToken: () => session.accessToken(),
  });
  const session = new TokenSession({ now }, redactor, credentials, () => client);

  log(
    `SIM only. Callback: ${callbackUrl(options.port)} (allowed by default on ports 80, 3000, 3001, 8080 and 31022; any other port must be added to the key).`,
  );
  await session.login({ port: options.port, client, log });
  log("Logged in. Tokens stay in memory.");

  const context: StepContext = {
    client,
    session,
    findings,
    symbol: options.symbol,
    accountOption: options.account,
    now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    shared: {},
  };
  let aborted = false;
  for (const [name, step] of STEPS) {
    if (!options.steps.includes(name)) continue;
    try {
      await step(context);
    } catch (error) {
      aborted = true;
      findings.add(name, "step", "FAIL", error instanceof Error ? error.message : "unknown error");
    }
  }

  mkdirSync(SCRATCH_DIR, { recursive: true });
  const reportPath = join(SCRATCH_DIR, "report.md");
  writeFileSync(
    reportPath,
    renderReport(findings.all, { date: sessionDate(now()), symbol: options.symbol }),
  );
  log(`Report: ${reportPath}`);
  log(`Samples: ${dirname(join(SAMPLES_DIR, "x"))}/<step>/*.json`);
  return aborted ? 1 : 0;
}
