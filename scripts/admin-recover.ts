// Recovers the last admin: `bun run admin:recover <email> [--remote]`. Deletes the admin's
// passkeys, recovery codes and sessions, revokes open links and prints a new activation link once
// (D31). Clients are recovered in the admin panel, so a non-admin email is refused.
import { ACTIVATION_LINK_LIFETIME_HOURS } from "#lib/domain/config.ts";
import { activationUrl, newInvitation } from "#lib/server/activation-link.ts";
import { adminLookupSql, recoverAdminSql } from "#lib/server/recover-admin.ts";
import { executeSqlFile, localOrigin, parseCli, productionOrigin, queryRows } from "./admin-cli.ts";

const { email, remote } = parseCli("admin:recover");

let found: unknown[];
try {
  found = await queryRows(adminLookupSql(email), remote);
} catch (failure) {
  console.error(failure instanceof Error ? failure.message : "lookup failed");
  process.exit(1);
}
const [admin] = found;
if (!admin) {
  console.error("No admin with that email. Clients are recovered in the admin panel.");
  process.exit(1);
}
if (typeof admin === "object" && "banned" in admin && admin.banned === 1) {
  console.error("That admin is disabled; recovery would not let them in.");
  process.exit(1);
}

const now = Date.now();
const { token, tokenHash, expiresAt } = await newInvitation(now);
const exitCode = await executeSqlFile(
  recoverAdminSql({ email, tokenHash, expiresAt, now }),
  remote,
  "admin-recover",
);
if (exitCode !== 0) {
  console.error(`wrangler failed (exit ${exitCode}). Nothing was shown; run it again.`);
  process.exit(1);
}

console.log(`Admin recovered: ${email} (passkeys, recovery codes and sessions removed)`);
console.log(
  `Activation link (valid ${ACTIVATION_LINK_LIFETIME_HOURS} hours, shown once, share it personally):`,
);
console.log(activationUrl(remote ? productionOrigin : localOrigin, token));
