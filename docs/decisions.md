# Decisions

Why the docs say what they say. **Product** decisions are the user's and are recorded in `ONBOARDING.md`. **Technical** decisions were made during the doc review on 2026-10-20, from the research noted, and can be revisited with a reason.

## Superseded by ONBOARDING (PDFs and demos, 16 Oct → 20 Oct 2026)

| # | Topic | PDFs / demos | Now |
| --- | --- | --- | --- |
| D1 | Product | the owner copies a provider's verbal alerts; post-session comparison with the provider | invited clients decide their own trades; no provider comparison |
| D2 | Users | owner only | a few invited clients, each with their own API key, isolated |
| D3 | Instruments | long options only | equities + long single-leg options; no futures |
| D4 | Stack | HTML/JS + Python/FastAPI | SvelteKit + TypeScript + Effect on Cloudflare |
| D5 | Domain | `app.reelcapital.com` | `thereelcapital.com` |
| D6 | SIZE | 20,000 with SIZE DOWN −25%/−50% | 20,000 per client, admin increases only |
| D7 | Daily lock | stop entries after 2 stop-outs, plus a money cap | 3 new entries per client · mode · day |
| D8 | Stop | fixed −30% | 30% default, admin per client, new positions only |
| D9 | Trailing | any time, 8% suggested | 10% default, unlocked at 70% confirmed sold (admin per client) |
| D10 | Premium | editable input | read-only TradeStation quote |
| D11 | Holding | intraday | multi-session |
| D12 | Palette | demo accents; ONBOARDING proposed `#121212/#1B1B1B/#F5F5F5` | monochrome tokens from the final designs: `#101010/#161616/#F3F3F0` |
| D13 | Demo tools | TEST STOP, reset session, simulated quote | not in the product |
| D14 | Kill switch | the PDFs required one | dropped: not in ONBOARDING. Deactivating a client and REAL being disabled cover the need |

Still valid from the PDFs: explicit order states; idempotency; no blind retries; cumulative rounding on the original quantity; accepted ≠ filled; ESTADO NO VERIFICADO; MARKET guarantees neither price nor SIZE.

## Product decisions of 2026-10-20

D15–D17 were never assigned; numbering continues from D18.

| # | Decision | Open part |
| --- | --- | --- |
| D18 | A scale-out step that rounds to 0 is marked used, its % counts toward the target, no order is sent, and the UI says «0 contratos por redondeo»; it doesn't count toward trailing | — |
| D19 | Trailing % chosen by the client from {1, 5, 8, 10, 15, 20}, default 10 | — |
| D20 | Server-enforced bounds: stop % 10–50 (default 30), trailing-unlock % 30–90 (default 70) | — |
| D21 | Additions to an open position are not supported in the pilot: a BUY on an instrument already open in that mode is rejected; re-entry after a full close is a new position. The counting rule (an additional BUY consumes an entry on its first fill) stays defined for later | — |
| D22 | Orders, fills, events and audit are kept 6 years; no deletion code until then. Pilot budget US$0/month on free tiers | — |
| D23 | IBM Plex Mono 400/500/600, self-hosted | — |
| D24 | Full admin panel in the pilot | — |
| D25 | Better Auth. **No email** (owner, 2026-10-21): the admin shares a single-use activation link; emails are identifiers only and are not verified | — |
| D26 | Keep Cloudflare Web Analytics (owner, 2026-10-21): Cloudflare injects the `static.cloudflareinsights.com` beacon into production pages. It is cookieless and the only off-origin request; the app itself loads nothing from other origins, and local and e2e runs make no external requests | — |
| D27 | Self-service recovery deletes **all** of the client's existing passkeys when a recovery code is redeemed (owner, 2026-10-21): a lost or stolen passkey stops working at once. Spending the code, revoking the sessions, deleting the passkeys and the audit rows are one D1 batch (count only, no credential material). The client's other unused codes stay valid until new ones are issued, so an interrupted recovery can be retried | — |
| D28 | Redeeming a recovery code and opening an activation link are each rate limited to 5 attempts per 10 minutes per IP (owner, 2026-10-21; `RECOVERY_REDEEM_RATE_LIMIT`, `ACTIVATION_REDEEM_RATE_LIMIT`) | — |
| D29 | Mobile tab bar keeps three tabs (Operar, Posiciones, Historial), as designed; Conexión is reached from the connection status in the top bar (owner, 2026-10-21) | — |
| D30 | ETF options are allowed, but every option's regular session is treated as ending at 16:00 ET, like stock options; the 16:00–16:15 window of ETF options is not offered (owner, 2026-10-21) | — |
| D31 | A locked-out admin is recovered by another admin through admin-run recovery (fresh session, audited, never one's own account); the last admin is recovered with `bun run admin:recover <email> --remote` from the owner's machine (owner, 2026-10-21; #109) | — |
| D32 | Activation-link tokens (32 random bytes) are stored as a plain SHA-256 of `activation-link:<token>`, not an HMAC keyed with `BETTER_AUTH_SECRET`, so `admin:create` and `admin:recover` never need the secret on the owner's machine and rotating the secret no longer invalidates pending links. Recovery codes keep the keyed HMAC (owner, 2026-10-21; #109). Links issued before this change stop working on deploy | — |
| D33 | Timings are decided as set in `src/lib/domain/config.ts`: warn 2 h before a known refresh-token expiry; renew the access token 5 min before it expires; an option chain snapshot is out of date after 30 s; sync-loop tick 5 s; an unanswered SENT order becomes UNKNOWN after 60 s; 60 s clock-skew allowance when matching a broker order to an intent; admin fan-out waits 4 s per client (owner, 2026-10-22). Revisit only if the SIM spike shows different broker behavior | — |
| D34 | No rate limit on passkey sign-in or on sending orders; activation and recovery keep D28 (owner, 2026-10-22) | the pilot is a few invited clients; orders are already bounded by the entry and position limits and by TradeStation's own limits |
| D35 | Connect by pasting the localhost redirect; registering the app callback on a key stays optional (owner, 2026-10-22). `/conexion` authorizes with `redirect_uri` `http://localhost:3000`, one of the callbacks every key allows by default; the page that fails to load holds the code, and the client pastes its address. The server checks the single-use, session-bound `state` and the engine exchanges the code with the same `redirect_uri`. `CONNECT_REDIRECT_MODE` in `src/lib/domain/config.ts` switches back to the registered `https://thereelcapital.com/conexion/callback` | — |
| D36 | Stops and trailing are **engine-held** (owner, 2026-10-22). The `ClientCoordinator` DO compares fresh bids with the effective exit level on the existing sync tick and sends a MARKET sell of `available` through the sell ledger and exit path (intent before the broker call, no retry, UNKNOWN reconciled). No broker `StopMarket` orders. | It works without the spike, reuses the MARKET exit path already verified, and keeps one working sell at a time. A broker-held stop on options is a possible later improvement if the spike (#21) shows SIM supports it; it is not built now |
| D37 | `STOP_REJECTED_COOLDOWN_MS` stays 30 s (owner, 2026-10-22). After the broker rejects an engine-held stop order, the engine waits 30 s (6 sync ticks) before sending a new one | long enough for a reconciliation tick to clear the cause, short enough to re-protect the position within half a minute |
| D38 | On mobile, `Admin` and `Cerrar sesión` live in a footer below the content, not in the top bar (owner, 2026-10-22). The top bar keeps the brand and the connection state; the tab bar keeps the three tabs of D29 | keeps the top bar and tab bar uncluttered on a phone and the tab bar to the screens that exist |
| D39 | Admins can edit a client's **name only**, and each change writes an audit entry with the acting admin and the old and new name (owner, 2026-10-23). Editing the email and the permissions of a profile (ONBOARDING «crear y editar perfiles», «gestionar permisos») is deferred | the name is the only profile field with no security weight; the email identifies the account and permissions change what it can do, so both wait until the pilot needs them |
| D40 | `SYNC_MIN_INTERVAL_MS` stays 2 s and `PROTECTION_SETTINGS_TTL_MS` stays 5 s, one sync tick (owner, 2026-10-23) | a screen is never visibly stale and bursts of page loads cost one broker read; settings changes reach the engine within one tick |
| D41 | `docs/` rank above `designs/`; designs win only on screen copy (owner, 2026-10-23) | the docs are the spec for behavior and layout rules; the design images are mock-ups whose exact Spanish copy is the part that is final |
| D42 | The trailing caption reads «Disponible desde N% vendido» on desktop and mobile (owner, 2026-10-23) | one wording across layouts, the one the code already shows |

| D43 | Better Auth's session cookie cache is on, `SESSION_COOKIE_CACHE_SECONDS` = 30 (owner, 2026-10-24) | authenticated reads skip the D1 session and user lookups (2 statements per request); a ban, role change or revocation may take up to 30 s to reach a browser that holds a cached copy, and only on reads: every mutating request reads D1 |

### Delegated decisions of 2026-10-21

The owner delegated D19–D22, asking for free, feasible options that keep every confirmed feature. The email question was then settled by the owner: no Cloudflare email option is free for arbitrary recipients (Email Sending needs Workers Paid; Email Routing only reaches verified destination addresses), so **the app sends no email**. The admin hands each client a single-use activation link (72 hours) in person, which replaces the email-OTP step; passkey-only sign-in and recovery codes are unchanged. Resend, Postmark and SES are not needed.

| Decision | Chosen | Why | Rejected |
| --- | --- | --- | --- |
| Trailing % set | {1, 5, 8, 10, 15, 20}, default 10 | the set from the demo the owner proposed; covers tight to wide trails | free-form input (error-prone) |
| Stop bounds | 10–50 %, default 30 | below 10 % a premium stop fires on normal option noise; above 50 % it stops being a protective stop | unbounded |
| Unlock bounds | 30–90 %, default 70 | 30 % is the first scale-out step; 90 % still leaves the last 10 % to trail | values that can never unlock (> 90 %) or unlock before any sale (< 30 %) |
| Adding to a position | not supported in the pilot | simplest rule with no new behavior to get wrong; re-entry after a full close still works | new-position semantics (uses a slot, confusing with the 2-position limit), merging (redefines base, steps, average and protections) |
| Retention | 6 years for orders, fills, events and audit | follows US broker recordkeeping practice (SEC Rule 17a-4); the data is tiny next to the free 5 GB | 1 year (too short for disputes and taxes), indefinite (no bound to plan storage against) |
| Budget | US$0/month on free tiers; Workers Paid (US$5/month) on the triggers in [architecture.md](architecture.md#costs-and-free-tier-limits) | the pilot fits the free limits | paying up front |

## Technical decisions of 2026-10-20

| # | Decision | Why |
| --- | --- | --- |
| T1 | **Two Workers in one repo** (`web` SvelteKit, `engine` with the DO) | adapter-cloudflare can't export DO classes or `scheduled` (kit#13692 open; PRs #13739 and #15627 closed unmerged). Post-build export patching is unsupported |
| T2 | **One DO per client**, mode as a column (refines ONBOARDING's "per client and mode" proposal; confirmed by the owner 2026-10-21) | one TradeStation connection serves both modes; a single owner means a single token refresher and one place for the limits. Every row and key is still mode-scoped |
| T3 | **The DO is the only TradeStation gateway**, including quotes and the chain | no token sharing between Workers; one rate-limit budget per client key |
| T4 | **Polling via DO alarms**, no HTTP streams initially (except the chain, which is stream-only) | fewer moving parts (no chunk parsing or reconnect logic); polling fits the per-key limits; revisit after the SIM spike |
| T5 | **`OrderConfirmID` = intent id** for idempotency | TradeStation uses it to deduplicate orders; there is no other client tag |
| T6 | **No fills table** | TradeStation reports leg `ExecQuantity` and the average `FilledPrice`; there is no executions endpoint |
| T7 | **`market-calendar`** (port of `pandas_market_calendars`, exact-pinned) for sessions, holidays and early closes; tests check it against NYSE's published dates | TradeStation has no calendar endpoint; a hand-kept date table goes stale. The port is young, so the pinned version and the fixture tests guard upgrades |
| T8 | **App-owned hashed recovery codes** | Better Auth backup codes need TOTP 2FA and are encrypted, not hashed |
| T9 | **Our own UV check** in the passkey `afterVerification` hooks | `@better-auth/passkey` hard-codes `requireUserVerification: false` |
| T10 | **Enrollment session from an activation link** (replaces email OTP, 2026-10-21) | Better Auth needs a session to register a passkey; without email or password, a validated activation link creates a 15-minute session restricted to passkey registration |
| T11 | **Admin overview by fan-out RPC** to client DOs, no read model | a few pilot clients; avoids keeping order state in two places |
| T12 | **One production environment** (SIM) + local | YAGNI; add staging when REAL is prepared |
| T13 | Stop/trailing are **engine-held**: the DO monitors fresh bids and sends a MARKET exit (D36) | decided 2026-10-22; broker-held stops may follow if the spike shows options support them |
| T14 | **Bun** for installs, scripts, unit tests (`bun test`) and ops scripts with Bun-native APIs; Node CLIs (Vite, Wrangler, Vitest, Playwright) launched by Bun but run on Node; no Bun APIs in Worker code | user decision; production runs in workerd, and Wrangler and Playwright require Node |
