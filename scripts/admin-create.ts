// Creates the first admin and prints an activation link: `bun run admin:create <email> [--remote]`.
// Writes through `wrangler d1 execute`, local by default. The link is shown once and never stored;
// only its SHA-256 is (docs/auth-and-security.md#flows). Consuming the link is the activation flow.
import { ACTIVATION_LINK_LIFETIME_HOURS } from "#lib/domain/config.ts";
import { activationUrl, newInvitation } from "#lib/server/activation-link.ts";
import { bootstrapAdminSql } from "#lib/server/bootstrap-admin.ts";
import { executeSqlFile, localOrigin, parseCli, productionOrigin } from "./admin-cli.ts";

const { email, remote } = parseCli("admin:create");

const now = Date.now();
const userId = crypto.randomUUID();
const { token, tokenHash, expiresAt } = await newInvitation(now);

// One file means one D1 batch: either the admin, the link and the audit row all exist, or none do.
const exitCode = await executeSqlFile(
  bootstrapAdminSql({ userId, email, tokenHash, expiresAt, now }),
  remote,
  "admin-create",
);
if (exitCode !== 0) {
  console.error(`wrangler failed (exit ${exitCode}). Is the email already registered?`);
  process.exit(1);
}

console.log(`Admin created: ${email}`);
console.log(
  `Activation link (valid ${ACTIVATION_LINK_LIFETIME_HOURS} hours, shown once, share it personally):`,
);
console.log(activationUrl(remote ? productionOrigin : localOrigin, token));
