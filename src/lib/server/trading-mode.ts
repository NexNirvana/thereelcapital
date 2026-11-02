import type { AllowedModes, Mode } from "#lib/domain/modes.ts";

export type TradingMode = Mode;

/** The client's chosen mode. A hint only: every request revalidates it against the engine (D52). */
export const MODE_COOKIE = "reel_modo";

export const modeCookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  secure: true,
} as const;

/** What the client sees when a form was prepared in another mode than the one now selected. */
export const MODE_MISMATCH_MESSAGE =
  "Cambiaste de modo en otra pestaña. Esta orden no se envió: revisa el modo actual y empieza de nuevo.";

/**
 * REAL only when it was asked for and the engine lists it. Entries and exits both count: with only
 * exits allowed REAL stays selectable so the client can still manage what is open (D52).
 */
export function resolveMode(requested: unknown, modes: AllowedModes | null): TradingMode {
  if (requested !== "REAL" || modes === null) return "SIM";
  return modes.entries.includes("REAL") || modes.exits.includes("REAL") ? "REAL" : "SIM";
}

/**
 * The mode of a request, revalidated against the client's modes from the engine. SIM needs no
 * answer; an engine that cannot answer, or a REAL no longer allowed, means SIM.
 */
export async function revalidatedMode(
  requested: string | undefined,
  readModes: () => Promise<{ ok: true; value: AllowedModes } | { ok: false }>,
): Promise<TradingMode> {
  if (requested !== "REAL") return "SIM";
  const result = await readModes().catch(() => null);
  return resolveMode(requested, result?.ok ? result.value : null);
}

/** True when a form's hidden `modo` is the request's revalidated mode. */
export function formModeMatches(form: FormData, mode: TradingMode): boolean {
  return form.get("modo") === mode;
}

/**
 * The mode every engine call of a request is made in: set by the hook after revalidation, SIM
 * for every route that does not read the cookie (the admin screens choose their own).
 */
export function modeFor(event: { locals: { mode: TradingMode } }): TradingMode {
  return event.locals.mode;
}
