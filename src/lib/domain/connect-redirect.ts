// Where TradeStation sends the browser back, and how a pasted address is read (decision D35,
// docs/tradestation-integration.md#connect-flow-implemented). Pure: the web Worker passes in the
// config and the app origin.

import { CONNECT_REDIRECT_MODE, PASTE_REDIRECT_URI } from "./config";

/** The one `redirect_uri` used for both the authorize URL and the code exchange. */
export function connectRedirectUri(
  appOrigin: string,
  mode: "paste" | "registered" = CONNECT_REDIRECT_MODE,
): string {
  return mode === "paste" ? PASTE_REDIRECT_URI : `${new URL(appOrigin).origin}/conexion/callback`;
}

export type PastedRedirect =
  | { readonly ok: true; readonly code: string; readonly state: string }
  /** TradeStation reported an error (the client declined, for one). */
  | { readonly ok: false; readonly reason: "DENIED" }
  /** Not the address we sent the browser to, or not a plain `code` and `state`. */
  | { readonly ok: false; readonly reason: "MALFORMED" }
  | { readonly ok: false; readonly reason: "MISSING_CODE" | "MISSING_STATE" };

const MAX_PASTE_LENGTH = 4096;
const ALLOWED_PARAMS: ReadonlySet<string> = new Set([
  "code",
  "state",
  "error",
  "error_description",
]);

/** Reads the address the client copied from the browser bar after authorizing. */
export function parsePastedRedirect(
  pasted: string,
  redirectUri: string = PASTE_REDIRECT_URI,
): PastedRedirect {
  const text = pasted.trim();
  if (text.length === 0 || text.length > MAX_PASTE_LENGTH || !URL.canParse(text)) {
    return { ok: false, reason: "MALFORMED" };
  }
  const url = new URL(text);
  const expected = new URL(redirectUri);
  const foreign =
    url.origin !== expected.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.hash !== "";
  const keys = [...url.searchParams.keys()];
  const unexpected =
    keys.some((key) => !ALLOWED_PARAMS.has(key)) || new Set(keys).size !== keys.length;
  if (foreign || unexpected) return { ok: false, reason: "MALFORMED" };

  if (url.searchParams.has("error")) return { ok: false, reason: "DENIED" };
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return { ok: false, reason: "MISSING_CODE" };
  if (!state) return { ok: false, reason: "MISSING_STATE" };
  return { ok: true, code, state };
}
