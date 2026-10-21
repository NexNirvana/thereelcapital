---
name: reel-security-review
description: Use when implementing or reviewing REEL CAPITAL auth and access control — Better Auth config, invitations, email OTP, passkeys, recovery codes, sessions, admin routes, client isolation, credential encryption — and before merging any change to a route that mutates state or touches credentials.
---

# REEL CAPITAL security review

Spec: `docs/auth-and-security.md`. Run this checklist on the diff.

## Better Auth gaps (each must have a test)

- [ ] Passkey UV enforced in **both** `registration.afterVerification` and `authentication.afterVerification` (the plugin itself accepts UV=false).
- [ ] Email-OTP sign-in and verification are refused for users who already have a passkey.
- [ ] Recovery uses the app's hashed `recovery_codes` with an atomic single-use update, not Better Auth backup codes.
- [ ] Sensitive actions check session age themselves (`sensitiveSessionMiddleware` doesn't).
- [ ] `/admin/impersonate-user` and `/admin/set-user-password` are in `disabledPaths`. `emailAndPassword` is disabled. `emailOTP.disableSignUp` is true. Rate-limit storage is `database`, keyed by `cf-connecting-ip`.

## Every mutating route

- [ ] The user and role come from the session; ids in the body or params are checked for ownership or ignored.
- [ ] Admin-only routes are checked on the server; admin changes write `audit_log` with before/after.
- [ ] Input is decoded with Effect `Schema`; unknown fields are rejected.
- [ ] Trading calls go to `ENGINE.getByName(session.userId)` and nowhere else.

## Secrets

- [ ] No secret or token in Git, logs, errors, responses, URLs (except `client_id` in the OAuth redirect) or `$lib` code reachable from the client.
- [ ] TradeStation secret and refresh token: AES-GCM in the engine Worker, random nonce, `key_id`.
- [ ] New secrets added to the docs' secrets list and set with `wrangler secret put`, never committed `.dev.vars`.
