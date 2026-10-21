---
name: reel-security-review
description: Use when implementing or reviewing REEL CAPITAL auth and access control — Better Auth config, activation links, passkeys, recovery codes, sessions, admin routes, client isolation, credential encryption — and before merging any change to a route that mutates state or touches credentials.
---

# REEL CAPITAL security review

Spec: `docs/auth-and-security.md`. Run this checklist on the diff.

## Better Auth gaps (each must have a test)

- [ ] Passkey UV enforced in **both** `registration.afterVerification` and `authentication.afterVerification` (the plugin itself accepts UV=false).
- [ ] Activation links: 32 random bytes, stored as HMAC, single use, 72 h expiry, regenerating invalidates the old one, never logged; the enrollment session they create can only register a passkey.
- [ ] Recovery uses the app's hashed `recovery_codes` with an atomic single-use update, not Better Auth backup codes.
- [ ] Sensitive actions check session age themselves (`sensitiveSessionMiddleware` doesn't).
- [ ] `/admin/impersonate-user` and `/admin/set-user-password` are in `disabledPaths`. `emailAndPassword` is disabled and no email plugin is installed. Rate-limit storage is `database`, keyed by `cf-connecting-ip`.

## Every mutating route

- [ ] The user and role come from the session; ids in the body or params are checked for ownership or ignored.
- [ ] Admin-only routes are checked on the server; admin changes write `audit_log` with before/after.
- [ ] Input is decoded with Effect `Schema`; unknown fields are rejected.
- [ ] Trading calls go to `ENGINE.getByName(session.userId)` and nowhere else.

## Secrets

- [ ] No secret or token in Git, logs, errors, responses, URLs (except `client_id` in the OAuth redirect) or code reachable from the client. Server-only code lives in `src/lib/server/` or `*.server.ts` files (SvelteKit refuses to bundle those into the browser), and secrets are read through `$app/env/private` or the engine's bindings.
- [ ] TradeStation secret and refresh token: AES-GCM in the engine Worker, random nonce, `key_id`.
- [ ] New secrets added to the docs' secrets list and set with `wrangler secret put`, never committed `.dev.vars`.
