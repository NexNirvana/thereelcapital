// Creates the first admin and prints an activation link: `bun run admin:create <email> [--remote]`.
// Writes through `wrangler d1 execute`, local by default. The link is shown once and never stored;
// only its SHA-256 is (docs/auth-and-security.md#flows). Consuming the link is the activation flow.
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { ACTIVATION_LINK_LIFETIME_HOURS } from "#lib/domain/config.ts";
import { activationUrl, newInvitation } from "#lib/server/activation-link.ts";
import { bootstrapAdminSql } from "#lib/server/bootstrap-admin.ts";

const productionOrigin = "https://thereelcapital.com";
const localOrigin = "http://localhost:8787";
// Deliberately strict: the value is placed inside a SQL literal.
const emailPattern = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

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

let cli: ReturnType<typeof parseArgs>;
try {
  cli = parseArgs(process.argv.slice(2));
} catch {
  console.error("usage: bun run admin:create <email> [--remote]");
  process.exit(1);
}
const { email, remote } = cli;

const now = Date.now();
const userId = crypto.randomUUID();
const { token, tokenHash, expiresAt } = await newInvitation(now);

// One file means one D1 batch: either the admin, the link and the audit row all exist, or none do.
const sql = bootstrapAdminSql({ userId, email, tokenHash, expiresAt, now });

const sqlFile = `${tmpdir()}/admin-create-${userId}.sql`;
await Bun.write(sqlFile, sql);
try {
  const result =
    await Bun.$`bunx wrangler d1 execute DB ${remote ? "--remote" : "--local"} --yes --file ${sqlFile}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    // wrangler's output can name the failing statement, which contains the token hash; show the tail only.
    console.error(`wrangler failed (exit ${result.exitCode}). Is the email already registered?`);
    process.exit(1);
  }
} finally {
  await Bun.file(sqlFile).delete();
}

const origin = remote ? productionOrigin : localOrigin;
console.log(`Admin created: ${email}`);
console.log(
  `Activation link (valid ${ACTIVATION_LINK_LIFETIME_HOURS} hours, shown once, share it personally):`,
);
console.log(activationUrl(origin, token));
