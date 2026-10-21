# Authentication and security

Library: **Better Auth** (`better-auth` + `@better-auth/passkey`, 1.7.x on 2026-10-20). Plugins: `admin`, `passkey`, `sveltekitCookies` (last).

**The app sends no email** (owner decision, 2026-10-21). The admin creates each client and hands over a single-use activation link personally; the client's email is only an identifier and is never verified. There is no email provider, no email OTP and no password.

## Gaps in Better Auth defaults

Better Auth's defaults do **not** meet our requirements in three places. Each needs app code and a test:

| Requirement | Better Auth default | What we do |
| --- | --- | --- |
| Passkey with user verification | registration UV can be requested, but verification is hard-coded `requireUserVerification: false`; sign-in sends `userVerification: "preferred"` | set `authenticatorSelection.userVerification: "required"` and throw in `registration.afterVerification` / `authentication.afterVerification` when `userVerified` is false |
| First passkey without email or password | passkey registration needs an existing session, and nothing else signs a new user in | after validating an activation link, the app creates a short-lived **enrollment session** that can only register a passkey; every other route rejects it |
| Single-use recovery codes | 2FA backup codes need TOTP/OTP 2FA enabled and are encrypted, not hashed | app-owned `recovery_codes` table (see below) |

## Configuration

- `emailAndPassword: { enabled: false }`; users are created only by an admin through `auth.api.createUser` (no password).
- `passkey({ rpID: "thereelcapital.com", origin: "https://thereelcapital.com", authenticatorSelection: { residentKey: "required", userVerification: "required" } })` plus the UV checks above.
- `admin({ adminRoles: ["admin"] })` with impersonation and password endpoints disabled through `disabledPaths` (`/admin/impersonate-user`, `/admin/set-user-password`).
- `rateLimit: { enabled: true, storage: "database" }` (in-memory limits are per isolate on Workers) and `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]`.
- `session.freshAge`: Better Auth measures it from session creation, and its `sensitiveSessionMiddleware` does **not** check freshness. For sensitive app actions we check `now − session.createdAt < 10 min` ourselves; re-auth = a new passkey sign-in.
- Secret in `BETTER_AUTH_SECRET` (Workers Secret, declared under `secrets.required` in `wrangler.jsonc`). Schema via `bunx auth@latest generate --config scripts/auth-schema.ts` → D1 migration (`migrations/0002_better_auth.sql`).
- Code: `src/lib/server/auth.ts` builds the instance; `src/hooks.server.ts` adds `sveltekitCookies` last, resolves the session into `locals.session` / `locals.user` and mounts `svelteKitHandler`. `baseURL`, the passkey `rpID` and the passkey `origin` all derive from one public variable, `APP_ORIGIN` (`https://thereelcapital.com` in `wrangler.jsonc`; local runs override it in `.dev.vars` or with `--var`), never from the request. The web Worker sets `workers_dev: false`: passkeys are bound to the domain, so no other hostname may serve the app.
- Passkey user verification is requested (`userVerification: "required"`) and enforced in `registration.afterVerification` and `authentication.afterVerification` (`requireUserVerified` in `src/lib/server/passkey-policy.ts`): an unverified ceremony fails with 403 `USER_VERIFICATION_REQUIRED` before any passkey is stored or session created. A banned user's sign-in fails with 403 `BANNED_USER` (the admin plugin refuses to create the session) and a Spanish message.
- Recovery endpoints are a Better Auth plugin (`src/lib/server/recovery-plugin.ts`) so they get its rate limiter (`RECOVERY_REDEEM_RATE_LIMIT`: provisional 5 attempts per 10 minutes per IP, in `config.ts` until decided) and cookie handling. `POST /api/auth/recovery/redeem {code}`: one answer, 401 `INVALID_RECOVERY_CODE`, for a wrong, used or suspended-account code; on success every session of the user is deleted, an `audit_log` row `recovery.redeem` is written and an enrollment session is created; if either write fails, the code is released again (only by the redemption that spent it) so a failed request never costs the client a code. `POST /api/auth/enrollment/complete`: needs an enrollment session in which a passkey was registered (403 `PASSKEY_REQUIRED` otherwise); it claims the session with a `DELETE` that must change one row, starts a full session, writes a new set of 10 codes (`recovery_codes.issue` audited, earlier codes deleted; the session comes first so a failure never destroys the old set) and returns the codes once with `Cache-Control: no-store`.
- Regeneration: `POST /api/recovery-codes` (`src/routes/api/recovery-codes/+server.ts`, logic in `recovery-regenerate.ts`) calls `requireFreshSession`, replaces the session user's whole set and returns the 10 new codes once (`no-store`), with a `recovery_codes.regenerate` audit row written in the same batch. The settings screen (a later milestone) only calls it; the user is always the session user, never a request value.
- Enrollment-only session: a normal Better Auth session with `session.enrollment = true` (migration `0004_enrollment_session.sql`), valid 15 minutes from `createdAt` (Better Auth refreshes `expiresAt` on read, so the age is checked from `createdAt`). `src/hooks.server.ts` runs `enrollmentGate` (`src/lib/server/enrollment.ts`) on every request: such a session resolves as signed out (`locals.user` and `locals.session` are null, `locals.enrollment` is set) and only the listed paths run (the recovery page, passkey registration, finishing enrollment, session read and sign-out). Every other path, including every other Better Auth endpoint, answers 403 `ENROLLMENT_ONLY` (pages redirect to `/recuperacion`); an expired one gets 401 `ENROLLMENT_EXPIRED`. Activation links (#15) reuse the same mechanism.
- Tokens (activation links, later recovery codes) are hashed with `hashToken` in `src/lib/server/token-hash.ts`: HMAC-SHA-256 keyed with `BETTER_AUTH_SECRET`, domain-separated by purpose (`activation-link:`, `recovery-code:`). Rotating `BETTER_AUTH_SECRET` therefore invalidates every pending link and code.

## Flows

**First admin:** `bun run admin:create <email>` (local D1, reads `BETTER_AUTH_SECRET` from the environment or `.dev.vars`) or `bun run admin:create <email> --remote` (production D1, `BETTER_AUTH_SECRET` must be exported in the shell) inserts the admin user and an activation link, in one D1 batch, and prints the link once. Opening the link is the activation flow below.

**Onboarding:**
1. The admin creates the user and `client_settings`. The app generates an activation link `https://thereelcapital.com/activar/<token>` (32 random bytes, base64url), stores only its HMAC, sets it to expire after 72 hours, and **shows it to the admin once**.
2. The admin shares the link personally (in person or a private message). The app never sends it.
3. The client opens it. The server checks that the token is unexpired and unused (rate-limited, never logged) and creates an enrollment session valid for 15 minutes, tied to that link. Opening the same link again replaces the earlier enrollment session.
4. The client registers a passkey (UV). Registration rechecks that the link is still unused, unexpired and not revoked, then marks it used in the same step.
5. The client receives 10 recovery codes, shown once, then configures TradeStation ([tradestation-integration.md](tradestation-integration.md)).

Trading requires all steps. Using, regenerating or revoking a link ends every enrollment session created from it, so an older session can't register a passkey afterwards. A TradeStation login never creates or activates a profile.

**Sign-in:** passkey only.

**Recovery (self-service):** recovery code → atomic `UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND <user not banned> RETURNING user_id` (rate-limited; the owner comes from the matching hash, so the client types only the code) → revoke all sessions → short-lived enrollment session that can only register a new passkey → new codes.

**Recovery (admin-controlled):** the admin verifies identity outside the app, then revokes sessions, deletes passkeys and codes, and generates a new activation link to share personally. It requires a fresh admin session, is audited, and never logs the admin in as the client.

A set is 10 codes (`RECOVERY_CODE_COUNT`), each 25 symbols from a 31-symbol alphabet without ambiguous characters (about 124 bits, `ABCDE-FGHJK-…`), drawn with WebCrypto and hashed with `hashToken("recovery-code", …)` over the normalized form (`src/lib/server/recovery-codes.ts`). Codes have no expiry of their own: they stay valid until used or replaced. Issuing a new set deletes every earlier code.

Recovery codes and activation tokens are high-entropy random strings stored as HMAC-SHA-256 with a server key.

## Sessions and requests

- Better Auth cookie session (Secure, HttpOnly, SameSite=Lax). SvelteKit's origin check plus Better Auth's `trustedOrigins` handle CSRF.
- Every server route and action resolves the user from the session and checks the role. Client-supplied user ids are ignored.
- Server helpers (`src/lib/server/`) make this uniform; routes and actions use them instead of reading `locals` directly:
  - `requireUser(event)` → 401 `AUTH_REQUIRED` without a session, 403 `FORBIDDEN` for a banned user. `requireAdmin(event)` → 403 `FORBIDDEN` unless `role` is `admin`.
  - `requireFreshSession(event)` → 401 `REAUTH_REQUIRED` unless `now − session.createdAt` is under 10 minutes (and not in the future). Admin mutations call `requireAdmin` then `requireFreshSession`.
  - `decode(schema, input)` → Effect `Schema` decode that rejects unknown fields; failure is 400 `INVALID_INPUT` and never echoes input.
  - `audit(db, { actor, action, targetUserId, before, after })` inserts into `audit_log` with bound parameters and throws on a credential-named key at any depth or on a failed write. `auditStatement` returns the statement so a mutation and its audit row commit in one `DB.batch`; use it for every admin mutation.
  - `engineFor(env.ENGINE, event)` → `ENGINE.getByName(session.user.id)`; there is no other way to address a client's Durable Object from web code.
  - Errors carry a stable `code` (`App.Error`) and a Spanish message.
- Disabling a client = `banUser` (it deletes sessions and blocks new ones). It does not touch broker orders.
- Logout or browser close does not affect protections; they live in the DO or at the broker.
- Pages load nothing from other origins except the Cloudflare Web Analytics beacon (`static.cloudflareinsights.com`), injected at the edge in production only (D26 in [decisions.md](decisions.md)). A future Content-Security-Policy must allow that script and its reporting endpoint.

## Secrets

- Never in Git, logs, responses, bundles or URLs: TradeStation client secret and tokens, `BETTER_AUTH_SECRET`, `CREDENTIALS_KEY`. `client_id` appears only in the OAuth redirect. Activation tokens appear only in their activation link and in the one-time admin response that shows it; never in Git, logs, bundles or any other response.
- TradeStation secret and refresh token: AES-GCM via WebCrypto, random nonce per value, `key_id` stored for rotation. Encryption and decryption happen in the engine Worker.
- `audit_log` stores before/after of settings and roles, never credential values.

## Isolation

- A client reaches only their own DO (`idFromName(session.userId)`); account ids are checked against that client's accounts from TradeStation.
- Admin screens read client DOs; they never place or cancel orders.
