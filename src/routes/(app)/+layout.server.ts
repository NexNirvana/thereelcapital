import { env } from "cloudflare:workers";
import { engineFor } from "#lib/server/engine.ts";
import type { LayoutServerLoad } from "./$types";

/** Recovery codes the user can still redeem; `undefined` when unreadable, so no false prompt. */
async function unusedRecoveryCodes(userId: string): Promise<number | undefined> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
  )
    .bind(userId)
    .first<{ n: number }>()
    .catch(() => null);
  return row?.n;
}

/** What the shell shows: the connection, the account, the admin link and the recovery-code prompt. */
export const load: LayoutServerLoad = async (event) => {
  const { locals } = event;
  if (!locals.user || locals.user.banned) return { health: undefined, account: null };
  const [result, unusedCodes] = await Promise.all([
    engineFor(env.ENGINE, event)
      .connection({ mode: "SIM" })
      .catch(() => null),
    unusedRecoveryCodes(locals.user.id),
  ]);
  const shell = { isAdmin: locals.user.role === "admin", unusedCodes };
  if (result === null || !result.ok) return { ...shell, health: undefined, account: null };
  // The account is shown only while there is a connection to show it for.
  return result.value.status === "CONNECTED"
    ? {
        ...shell,
        health: result.value.health,
        account: result.value.accounts[0]?.accountId ?? null,
      }
    : { ...shell, health: null, account: null };
};
