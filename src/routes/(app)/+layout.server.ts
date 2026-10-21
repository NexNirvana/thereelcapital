import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
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
  // Every page of the shell needs a signed-in client: anonymous visitors go to /acceso and a banned
  // one gets 403. Pages and actions guard themselves too (SvelteKit runs loads in parallel).
  if (!event.locals.user) redirect(303, resolve("/acceso"));
  const { user } = requireUser(event);
  const [result, unusedCodes] = await Promise.all([
    engineFor(env.ENGINE, event)
      .connection({ mode: "SIM" })
      .catch(() => null),
    unusedRecoveryCodes(user.id),
  ]);
  const shell = { isAdmin: user.role === "admin", unusedCodes };
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
