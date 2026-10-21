import { json } from "@sveltejs/kit";
import { requireFreshSession, type GuardEvent, type GuardLocals } from "./guards.ts";
import { replaceRecoveryCodes, type RecoveryDb, type RecoveryStatement } from "./recovery-codes.ts";

/**
 * "Regenerate from the client's settings" (docs/auth-and-security.md#flows): a fresh session
 * replaces the user's whole set. The owner is the session user; nothing in the request names
 * whose codes to replace. The codes are in this response and nowhere else.
 */
export async function regenerateRecoveryCodes<L extends GuardLocals, S extends RecoveryStatement>(
  event: GuardEvent<L>,
  db: RecoveryDb<S>,
  secret: string,
): Promise<Response> {
  const actor = requireFreshSession(event);
  const codes = await replaceRecoveryCodes(db, secret, {
    actor,
    userId: actor.user.id,
    action: "recovery_codes.regenerate",
  });
  return json({ codes }, { headers: { "cache-control": "no-store" } });
}
