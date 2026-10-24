// The session cookie cache (decision D43, docs/auth-and-security.md#session-cookie-cache). Better
// Auth keeps a signed copy of the session and user in the `session_data` cookie for
// SESSION_COOKIE_CACHE_SECONDS, so reads skip D1. The owner accepted that a ban, role change or
// revocation takes that long to reach a browser holding a copy. Everything that changes state
// stays immediate: those requests never see the copy and read D1.
import type { BetterAuthPlugin } from "better-auth";

// A GET that stores credentials is a mutation by effect (the TradeStation connect callback), and
// Better Auth has GET endpoints that gate sensitive work (passkey registration options). Of the
// auth API only the session read itself may use the copy.
const authoritativePaths = new Set(["/conexion/callback"]);
const authApiReadsWithCache = new Set(["/api/auth/get-session"]);

/** True when the request may be served from the cached session copy. */
export function mayUseSessionCache(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname.startsWith("/api/auth/")) return authApiReadsWithCache.has(pathname);
  return !authoritativePaths.has(pathname);
}

// `session_data`, its chunks (`session_data.0`, ...) and the `__Secure-` variant.
const sessionDataCookie = /^(?:__Secure-)?better-auth\.session_data(?:\.\d+)?$/;

/** Removes the cached session copy from a Cookie header; other cookies are kept as they are. */
export function withoutSessionCache(cookieHeader: string): string {
  return cookieHeader
    .split(/;\s*/)
    .filter((pair) => pair !== "" && !sessionDataCookie.test(pair.split("=")[0]?.trim() ?? ""))
    .join("; ");
}

/**
 * Makes every Better Auth endpoint that mutates (including the ones that only check the session
 * in a hook: UV, fresh session, enrollment claims, passkey management) authoritative: the request
 * reaches them without the cached copy, so the session is read from D1.
 */
export function sessionCachePolicyPlugin() {
  return {
    id: "session-cache-policy",
    async onRequest(request) {
      const url = new URL(request.url);
      const cookie = request.headers.get("cookie");
      if (mayUseSessionCache(request.method, url.pathname) || !cookie) return;
      const headers = new Headers(request.headers);
      const kept = withoutSessionCache(cookie);
      if (kept) headers.set("cookie", kept);
      else headers.delete("cookie");
      return { request: new Request(request, { headers }) };
    },
  } satisfies BetterAuthPlugin;
}
