// What `admin-create.ts` and `admin-recover.ts` share: argument decoding and running SQL on D1
// through wrangler (local by default). Neither script needs BETTER_AUTH_SECRET (D32).
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { emailPattern } from "#lib/server/bootstrap-admin.ts";

export const productionOrigin = "https://thereelcapital.com";
export const localOrigin = "http://localhost:8787";

const CliArgs = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(emailPattern)),
  remote: Schema.Boolean,
});

// Any argument that is not one email and the optional --remote flag fails the decode.
function parseArgs(argv: string[]) {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  return Schema.decodeUnknownSync(CliArgs)({
    email: positional.length === 1 ? positional[0]?.trim().toLowerCase() : undefined,
    remote:
      flags.length === 0 ? false : flags.length === 1 && flags[0] === "--remote" ? true : undefined,
  });
}

/** `<email> [--remote]` from the command line, or exits with the usage line. */
export function parseCli(command: string, argv = process.argv.slice(2)) {
  try {
    return parseArgs(argv);
  } catch {
    console.error(`usage: bun run ${command} <email> [--remote]`);
    process.exit(1);
  }
}

const target = (remote: boolean) => (remote ? "--remote" : "--local");

/** Runs a SQL file as one D1 execution; wrangler's output can name statements, so it is not shown. */
export async function executeSqlFile(sql: string, remote: boolean, label: string) {
  const sqlFile = `${tmpdir()}/${label}-${crypto.randomUUID()}.sql`;
  await Bun.write(sqlFile, sql);
  try {
    const result =
      await Bun.$`bunx wrangler d1 execute DB ${target(remote)} --yes --file ${sqlFile}`
        .quiet()
        .nothrow();
    return result.exitCode;
  } finally {
    await Bun.file(sqlFile).delete();
  }
}

/** Rows of one read-only query (`--json` output of wrangler). */
export async function queryRows(sql: string, remote: boolean): Promise<unknown[]> {
  const result =
    await Bun.$`bunx wrangler d1 execute DB ${target(remote)} --yes --json --command ${sql}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) throw new Error(`wrangler failed (exit ${result.exitCode})`);
  const Output = Schema.Array(Schema.Struct({ results: Schema.Array(Schema.Unknown) }));
  return [
    ...(Schema.decodeUnknownSync(Output)(JSON.parse(result.stdout.toString()))[0]?.results ?? []),
  ];
}
