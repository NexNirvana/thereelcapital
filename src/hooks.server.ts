import { building } from "$app/env";
import { getRequestEvent } from "$app/server";
import { json, redirect } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";
import { sveltekitCookies, svelteKitHandler } from "better-auth/svelte-kit";
import { env } from "cloudflare:workers";
import { createAuth } from "#lib/server/auth.ts";
import { enrollmentGate } from "#lib/server/enrollment.ts";
import { withSecurityHeaders } from "#lib/server/security-headers.ts";

const handleRequest: Handle = async ({ event, resolve }) => {
  // sveltekitCookies goes last so cookies set by Better Auth reach SvelteKit responses.
  const auth = createAuth(env, { trailingPlugins: [sveltekitCookies(getRequestEvent)] });

  // The user and role come only from the verified session; routes never read ids from the client.
  const session = await auth.api.getSession({ headers: event.request.headers });
  event.locals.session = session?.session ?? null;
  event.locals.user = session?.user ?? null;
  event.locals.enrollment = null;

  // An enrollment-only session is not a signed-in user: guards and loads see nobody, and only the
  // paths in enrollment.ts run at all (docs/auth-and-security.md#flows).
  const gate = enrollmentGate(session?.session ?? null, event.url.pathname);
  if (gate.kind === "enrollment") {
    event.locals.session = null;
    event.locals.user = null;
    if (!gate.allowed) {
      if (gate.expired) {
        return json(
          {
            code: "ENROLLMENT_EXPIRED",
            message: "Tu sesión de registro venció. Empieza de nuevo.",
          },
          { status: 401 },
        );
      }
      if (event.request.method === "GET" && !event.url.pathname.startsWith("/api/")) {
        redirect(303, "/recuperacion");
      }
      return json(
        {
          code: "ENROLLMENT_ONLY",
          message: "Registra tu nueva passkey para continuar.",
        },
        { status: 403 },
      );
    }
    if (!gate.expired && session)
      event.locals.enrollment = {
        userId: session.user.id,
        invitationId: session.session.invitationId ?? null,
      };
  }

  return svelteKitHandler({ auth, event, resolve, building });
};

// Outermost, so the enrollment gate's own answers and Better Auth's responses carry the headers too.
export const handle: Handle = async (input) => withSecurityHeaders(await handleRequest(input));
