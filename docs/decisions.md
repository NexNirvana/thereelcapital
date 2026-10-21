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
| T2 | **One DO per client**, mode as a column (refines ONBOARDING's "per client and mode" proposal) | one TradeStation connection serves both modes; a single owner means a single token refresher and one place for the limits. Every row and key is still mode-scoped |
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
| T13 | Stop/trailing **residency decided by the SIM spike** (broker StopMarket/TrailingStop vs DO monitoring) | v3 supports both order types; option support is unconfirmed |
| T14 | **Bun** for installs, scripts, unit tests (`bun test`) and ops scripts with Bun-native APIs; Node CLIs (Vite, Wrangler, Vitest, Playwright) launched by Bun but run on Node; no Bun APIs in Worker code | user decision; production runs in workerd, and Wrangler and Playwright require Node |
