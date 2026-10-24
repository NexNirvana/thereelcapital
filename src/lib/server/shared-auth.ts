import type { Auth, AuthEnv } from "./auth.ts";

// One Better Auth instance per isolate. Building it also runs the adapter's schema check
// (a dozen D1 introspection statements), so a fresh instance per request paid that on every
// request. Better Auth keeps per-request state (response headers, session) on a copy of its
// context made for each call, and sveltekitCookies reads the request event when the hook runs,
// so a shared instance is safe (issue #230).
//
// The cache holds only while the binding object, secret and origin are the ones the instance was
// built with: a different binding (or changed config) builds a new instance instead of serving
// a stale one.
const cache = new WeakMap<object, { secret: string; origin: string; auth: Auth }>();

export function sharedAuth(env: AuthEnv, build: () => Auth): Auth {
  const hit = cache.get(env.DB);
  if (hit && hit.secret === env.BETTER_AUTH_SECRET && hit.origin === env.APP_ORIGIN)
    return hit.auth;

  const auth = build();
  const entry = { secret: env.BETTER_AUTH_SECRET, origin: env.APP_ORIGIN, auth };
  cache.set(env.DB, entry);
  // A failed init must not stick for the life of the isolate: the next request builds again.
  auth.$context.catch(() => {
    if (cache.get(env.DB) === entry) cache.delete(env.DB);
  });
  return auth;
}
