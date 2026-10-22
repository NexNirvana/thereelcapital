// Fails when the built client assets contain a secret name or something shaped like a token
// (docs/auth-and-security.md#secrets). Usage: bun scripts/check-client-bundle.ts [assets dir]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SECRET_NAMES = [
  "BETTER_AUTH_SECRET",
  "CREDENTIALS_KEY",
  "TRADINGSTATION_",
  "TRADINGSTATION",
  "CLOUDFLARE_API_TOKEN",
  "client_secret",
  "refresh_token",
];

const TOKEN_PATTERNS: [string, RegExp][] = [
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer token", /Bearer\s+[A-Za-z0-9._~+/-]{24,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Cloudflare API token", /\bcfut_[A-Za-z0-9]{30,}\b/],
];

export interface Finding {
  file: string;
  what: string;
}

// better-auth's client chunk ships an env-reading helper that mentions the name
// (`get BETTER_AUTH_SECRET(){return read("BETTER_AUTH_SECRET")}`); in the browser it reads an empty
// object, so only that exact accessor shape is ignored, not the name in general.
const BETTER_AUTH_ENV_ACCESSOR =
  /get BETTER_AUTH_SECRET\(\)\{return \w+\([`'"]BETTER_AUTH_SECRET[`'"]\)\}/g;

/** Names only, never the matched text: the CI log must not become the leak. */
export function scanText(file: string, text: string): Finding[] {
  const named = text.replace(BETTER_AUTH_ENV_ACCESSOR, "");
  const names = SECRET_NAMES.filter((name) => named.includes(name)).map((name) => ({
    file,
    what: `secret name ${name}`,
  }));
  const tokens = TOKEN_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => ({
    file,
    what: `${label} pattern`,
  }));
  return [...names, ...tokens];
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

if (import.meta.main) {
  const root = process.argv[2] ?? ".svelte-kit/cloudflare";
  const findings: Finding[] = [];
  let scanned = 0;
  for (const path of files(root)) {
    // The Worker entry is server code; everything else is served to browsers.
    if (path === join(root, "_worker.js") || /\.(woff2?|png|ico|jpg|webp)$/.test(path)) continue;
    scanned += 1;
    findings.push(...scanText(path, readFileSync(path, "utf8")));
  }
  if (scanned === 0) {
    console.error(`No client assets under ${root}: run the build first.`);
    process.exit(2);
  }
  for (const { file, what } of findings) console.error(`${file}: ${what}`);
  console.log(`Scanned ${scanned} client files: ${findings.length} findings.`);
  process.exit(findings.length === 0 ? 0 : 1);
}
