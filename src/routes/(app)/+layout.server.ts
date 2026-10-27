import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { engineFor } from "#lib/server/engine.ts";
import { shellConnection } from "#lib/server/shell-connection.ts";
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
  // Reading the URL makes SvelteKit rerun this load on every navigation, so a screen reached by
  // a client-side link never shows a connection older than the visit; a refresh that keeps the
  // URL (the chain's `app:chain`) leaves it alone.
  void event.url.href;
  // A screen that stays open (Posiciones) asks for it again now and then, so the alert follows a
  // connection that drops or recovers without a navigation.
  event.depends("app:connection");
  const [result, unusedCodes] = await Promise.all([
    engineFor(env.ENGINE, event)
      .connection({ mode: "SIM" })
      .catch(() => null),
    unusedRecoveryCodes(user.id),
  ]);
  const shell = { isAdmin: user.role === "admin", unusedCodes };
  // The pages read this through `await parent()` instead of asking the engine again.
  const connection = shellConnection(result);
  const view = connection?.ok ? connection.view : null;
  return {
    ...shell,
    connection,
    // Unreadable: no indicator (undefined). Connected: the health and the account to show.
    health: connection?.ok ? (view?.status === "CONNECTED" ? view.health : null) : undefined,
    account: view?.status === "CONNECTED" ? (view.accounts[0]?.accountId ?? null) : null,
  };
};
