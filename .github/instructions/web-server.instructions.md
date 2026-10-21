---
applyTo: "src/hooks.server.ts,src/lib/server/**,src/routes/**/*.server.ts,src/routes/**/+server.ts"
---

# Web Worker server code

Spec: `docs/auth-and-security.md`.

- The user and role come only from the Better Auth session; ids in params or bodies are ownership-checked or ignored. Trading calls go to `ENGINE.getByName(session.userId)` and nowhere else.
- Admin routes check the role on the server, require a fresh session for changes, and write `audit_log` with before/after (never secret values). Admins never place or cancel client orders or impersonate clients.
- Better Auth gaps the app must cover: passkey user verification checked in both `afterVerification` hooks; onboarding only through a validated single-use activation link whose enrollment session can only register a passkey (the app sends no email); recovery through the app's hashed single-use `recovery_codes`; session freshness checked explicitly (`sensitiveSessionMiddleware` doesn't).
- No public sign-up path; impersonation and set-password endpoints stay disabled.
- Decode form and JSON input with Effect `Schema` and reject unknown fields. Errors to users carry a stable code and a Spanish message; details go to logs without secrets.
- The web Worker never calls TradeStation and never holds tokens.
