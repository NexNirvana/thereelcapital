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
- Secret in `BETTER_AUTH_SECRET` (Workers Secret). Schema via `bunx auth@latest generate` → D1 migration.

## Flows

**Onboarding:**
1. The admin creates the user and `client_settings`. The app generates an activation link `https://thereelcapital.com/activar/<token>` (32 random bytes, base64url), stores only its HMAC, sets it to expire after 72 hours, and **shows it to the admin once**.
2. The admin shares the link personally (in person or a private message). The app never sends it.
3. The client opens it. The server checks that the token is unexpired and unused (rate-limited, never logged) and creates an enrollment session valid for 15 minutes, tied to that link. Opening the same link again replaces the earlier enrollment session.
4. The client registers a passkey (UV). Registration rechecks that the link is still unused, unexpired and not revoked, then marks it used in the same step.
5. The client receives 10 recovery codes, shown once, then configures TradeStation ([tradestation-integration.md](tradestation-integration.md)).

Trading requires all steps. Using, regenerating or revoking a link ends every enrollment session created from it, so an older session can't register a passkey afterwards. A TradeStation login never creates or activates a profile.

**Sign-in:** passkey only.

**Recovery (self-service):** recovery code → atomic `UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL` (rate-limited) → revoke all sessions → short-lived enrollment session that can only register a new passkey → new codes.

**Recovery (admin-controlled):** the admin verifies identity outside the app, then revokes sessions, deletes passkeys and codes, and generates a new activation link to share personally. It requires a fresh admin session, is audited, and never logs the admin in as the client.

Recovery codes and activation tokens are high-entropy random strings stored as HMAC-SHA-256 with a server key.

## Sessions and requests

- Better Auth cookie session (Secure, HttpOnly, SameSite=Lax). SvelteKit's origin check plus Better Auth's `trustedOrigins` handle CSRF.
- Every server route and action resolves the user from the session and checks the role. Client-supplied user ids are ignored.
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
