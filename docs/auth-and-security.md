# Authentication and security

Library: **Better Auth** (`better-auth` + `@better-auth/passkey`, 1.7.x on 2026-10-20). Plugins: `admin`, `emailOTP`, `passkey`, `sveltekitCookies` (last). Email goes through **Resend** (free plan: 3,000 emails/month, 100/day) with a plain `fetch` to its HTTP API; no SDK. Better Auth calls our `sendVerificationOTP`, and the app sends invitations itself, both through one `sendEmail` function. The sending domain `thereelcapital.com` is verified in Resend with the DNS records it gives (SPF/DKIM), added on Cloudflare.

## Gaps in Better Auth defaults

Better Auth's defaults do **not** meet our requirements in three places. Each needs app code and a test:

| Requirement | Better Auth default | What we do |
| --- | --- | --- |
| Passkey with user verification | registration UV can be requested, but verification is hard-coded `requireUserVerification: false`; sign-in sends `userVerification: "preferred"` | set `authenticatorSelection.userVerification: "required"` and throw in `registration.afterVerification` / `authentication.afterVerification` when `userVerified` is false |
| Passkey is the only sign-in | `/sign-in/email-otp` signs in any existing user | allow email-OTP endpoints only for users whose onboarding is pending (no passkey yet); reject otherwise in a `hooks.before` guard |
| Single-use recovery codes | 2FA backup codes need TOTP/OTP 2FA enabled and are encrypted, not hashed | app-owned `recovery_codes` table (see below) |

## Configuration

- `emailAndPassword: { enabled: false }`; users are created only by an admin through `auth.api.createUser` (no password).
- `emailOTP({ disableSignUp: true, storeOTP: "hashed", expiresIn: 600, allowedAttempts: 3 })`.
- `passkey({ rpID: "thereelcapital.com", origin: "https://thereelcapital.com", authenticatorSelection: { residentKey: "required", userVerification: "required" } })` plus the UV checks above.
- `admin({ adminRoles: ["admin"] })` with impersonation and password endpoints disabled through `disabledPaths` (`/admin/impersonate-user`, `/admin/set-user-password`).
- `rateLimit: { enabled: true, storage: "database" }` (in-memory limits are per isolate on Workers) and `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]`.
- `session.freshAge`: Better Auth measures it from session creation, and its `sensitiveSessionMiddleware` does **not** check freshness. For sensitive app actions we check `now − session.createdAt < 10 min` ourselves; re-auth = a new passkey sign-in.
- Secret in `BETTER_AUTH_SECRET` (Workers Secret). Schema via `bunx auth@latest generate` → D1 migration.

## Flows

**Onboarding:** admin creates the user and `client_settings` and sends an invitation → the client opens the link (token hashed, single use, expires) → email OTP → registers a passkey (UV) → receives 10 recovery codes shown once → configures TradeStation ([tradestation-integration.md](tradestation-integration.md)). Trading requires all steps. A TradeStation login never creates or activates a profile.

**Sign-in:** passkey only.

**Recovery (self-service):** recovery code → atomic `UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL` (rate-limited) → revoke all sessions → short-lived enrollment session that can only register a new passkey → new codes. An email alone never removes MFA.

**Recovery (admin-controlled):** the admin verifies identity outside the app, then revokes sessions, deletes passkeys and codes, and issues a fresh invitation. It requires a fresh admin session, is audited, and never logs the admin in as the client.

Codes are high-entropy random strings stored as HMAC-SHA-256 with a server key.

## Sessions and requests

- Better Auth cookie session (Secure, HttpOnly, SameSite=Lax). SvelteKit's origin check plus Better Auth's `trustedOrigins` handle CSRF.
- Every server route and action resolves the user from the session and checks the role. Client-supplied user ids are ignored.
- Disabling a client = `banUser` (it deletes sessions and blocks new ones). It does not touch broker orders.
- Logout or browser close does not affect protections; they live in the DO or at the broker.

## Secrets

- Never in Git, logs, responses, bundles or URLs: TradeStation client secret and tokens, `BETTER_AUTH_SECRET`, `CREDENTIALS_KEY`, the email key. `client_id` appears only in the OAuth redirect.
- TradeStation secret and refresh token: AES-GCM via WebCrypto, random nonce per value, `key_id` stored for rotation. Encryption and decryption happen in the engine Worker.
- `audit_log` stores before/after of settings and roles, never credential values.

## Isolation

- A client reaches only their own DO (`idFromName(session.userId)`); account ids are checked against that client's accounts from TradeStation.
- Admin screens read client DOs; they never place or cancel orders.
