import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import { env } from "cloudflare:workers";
import { engineFor } from "#lib/server/engine.ts";
import { requireUser } from "#lib/server/guards.ts";
import { MODE_COOKIE, modeCookieOptions, resolveMode } from "#lib/server/trading-mode.ts";
import type { RequestHandler } from "./$types";

// Switching mode is a server action, never a client-side flag: the engine lists the modes the
// client may use, and only then does the cookie change. Any unsent order form is discarded because
// the redirect loads a fresh page (a form from the other mode would be refused anyway).
export const POST: RequestHandler = async (event) => {
  requireUser(event);
  const form = await event.request.formData();
  const modes = await engineFor(env.ENGINE, event)
    .modes()
    .catch(() => null);
  const mode = resolveMode(form.get("modo"), modes?.ok ? modes.value : null);
  if (mode === "REAL") event.cookies.set(MODE_COOKIE, "REAL", modeCookieOptions);
  else event.cookies.delete(MODE_COOKIE, modeCookieOptions);
  // Back to the screen the client was on, from a short list so the body cannot choose a target.
  const screens = new Map([
    ["posiciones", resolve("/(app)/posiciones")],
    ["historial", resolve("/(app)/historial")],
    ["conexion", resolve("/(app)/conexion")],
  ]);
  const back = form.get("volver");
  redirect(
    303,
    (typeof back === "string" ? screens.get(back) : undefined) ?? resolve("/(app)/operar"),
  );
};
