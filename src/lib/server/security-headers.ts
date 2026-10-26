// Response headers every page and endpoint carries (docs/auth-and-security.md#security-headers).
// The Content-Security-Policy itself is `kit.csp` in vite.config.ts, because SvelteKit adds the
// nonces and hashes of its own inline script there.

// One year, subdomains included. No `preload`: it is hard to undo and nothing in the docs asks for it.
const HSTS = "max-age=31536000; includeSubDomains";

// Passkeys (publickey-credentials-*) stay on their default of this origin; everything else the app
// never uses is switched off.
const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

/** Sets the headers on a mutable `Headers`. A stricter value a route already set is kept. */
export function applySecurityHeaders(headers: Headers): void {
  headers.set("strict-transport-security", HSTS);
  headers.set("x-content-type-options", "nosniff");
  // The CSP `frame-ancestors 'none'` is the rule; this is the same for browsers that predate it.
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", PERMISSIONS_POLICY);
  // Activation and the OAuth callback send no-referrer because their URL carries a secret.
  if (!headers.has("referrer-policy"))
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
}

/** The response with the headers applied; redirects and `fetch` results have immutable headers. */
export function withSecurityHeaders(response: Response): Response {
  // A WebSocket upgrade (101) has no body to re-wrap, and copying it would drop the socket.
  if (response.status === 101) return response;
  const secured = new Response(response.body, response);
  applySecurityHeaders(secured.headers);
  return secured;
}
