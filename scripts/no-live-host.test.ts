import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const hook = resolve(import.meta.dir, "../.githooks/no-live-host");
const live = ["api", "tradestation", "com"].join("."); // assembled: this file must not name the host

let repo: string;

function git(...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

/** Stages `content` at `path` in a throwaway repo and returns the hook's verdict. */
function check(path: string, content: string): { rejected: boolean; stderr: string } {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  git("add", "-A");
  const run = Bun.spawnSync([hook, "--cached"], { cwd: repo });
  git("reset", "-q");
  rmSync(absolute);
  return { rejected: run.exitCode !== 0, stderr: run.stderr.toString() };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "no-live-host-"));
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("no-live-host", () => {
  test.each([
    ["with a version path", `https://${live}/v3/orderexecution/orders`],
    ["without a version path", `https://${live}`],
    ["without a scheme", `fetch("${live}/brokerage")`],
    ["with a port", `https://${live}:443/v3`],
    ["in upper case", `HTTPS://${live.toUpperCase()}/V3`],
    ["next to the SIM host", `https://sim-${live}/v3 https://${live}/v3`],
    ["as a different prefixed host", `https://live-${live}/v3`],
  ])("rejects the live host %s", (_name, line) => {
    const result = check("src/broker.ts", `const url = "${line}";\n`);
    expect(result.rejected).toBe(true);
    expect(result.stderr).toContain("src/broker.ts");
  });

  test.each([
    ["the SIM host", `https://sim-${live}/v3/brokerage/accounts`],
    ["the auth host", "https://signin.tradestation.com/oauth/token"],
  ])("allows %s", (_name, line) => {
    expect(check("src/broker.ts", `const url = "${line}";\n`).rejected).toBe(false);
  });

  test("allows the OAuth audience constant only in the allowlisted files", () => {
    const constant = `export const AUDIENCE = "https://${live}";\n`;
    const property = `  audience: "https://${live}",\n`;
    expect(check("engine/src/tradestation/endpoints.ts", constant).rejected).toBe(false);
    expect(check("engine/test/connection.test.ts", property).rejected).toBe(false);
    expect(check("src/elsewhere.ts", constant).rejected).toBe(true);
  });

  test("does not let the audience allowance hide a request target", () => {
    for (const path of ["engine/src/tradestation/endpoints.ts", "engine/test/a.test.ts"]) {
      expect(check(path, `fetch("https://${live}");\n`).rejected).toBe(true);
      expect(check(path, `const url = "https://${live}";\n`).rejected).toBe(true);
    }
  });

  test("does not let the audience allowance hide a request target on the same line", () => {
    const line = `const AUDIENCE = "https://${live}"; fetch("https://${live}/v3/x");\n`;
    expect(check("engine/src/tradestation/endpoints.ts", line).rejected).toBe(true);
  });

  test("allows documentation links in Markdown but not an API route", () => {
    expect(check("NOTES.md", `[spec](https://${live}/docs/fundamentals/)\n`).rejected).toBe(false);
    expect(check("NOTES.md", `call https://${live}/v3/orders\n`).rejected).toBe(true);
    expect(check("src/a.ts", `// https://${live}/docs/fundamentals/\n`).rejected).toBe(true);
  });

  test("ignores docs/", () => {
    expect(check("docs/notes.md", `https://${live}/v3/orders\n`).rejected).toBe(false);
  });
});
