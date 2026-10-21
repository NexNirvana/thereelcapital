# Review instructions for REEL CAPITAL

Invitation-only web terminal where a few clients trade US equities and long single-leg options in their own TradeStation accounts. MARKET orders only, regular session only, TradeStation **SIM** only. SvelteKit 3 + TypeScript + Effect + Better Auth on Cloudflare Workers (two Workers: `web` and `engine`), D1, one SQLite Durable Object (`ClientCoordinator`, one per client). Bun runs installs, scripts and unit tests; Worker code runs in workerd. The spec is in `docs/`; `ONBOARDING.md` wins on conflicts.

## Block the PR (flag as critical)

- Any reference to the live TradeStation API host, a LIVE/REAL code path, or an order request not provably sent to `https://sim-api.tradestation.com/v3`. Real money must never be at risk.
- Secrets, tokens, OTPs or recovery codes in code, logs, errors, responses, URLs or client-reachable modules. Server-only code belongs in `src/lib/server/`, `*.server.ts` or the engine.
- Client or account identity taken from the request instead of the verified session; a query or DO call not scoped by the session user.
- Order placement or cancellation that is retried, or sent before its intent is persisted with `OrderConfirmID`.
- Quantity, SIZE or price accepted from the browser instead of computed on the server from the client's SIZE and the broker's ask.
- Any order type other than Market, short selling, SELLTOOPEN or BUYTOCLOSE getting through the server.
- AI attribution anywhere (`Co-Authored-By`, "Generated with", tool names) in commits, PR text or code.

## Review for

- **Correctness of trading rules** against `docs/domain-rules.md` and `docs/order-lifecycle.md`: limits block entries but never exits or cancels; quantities use confirmed fills; no oversell under concurrency; no `await` between reading and writing counters or ledgers inside the Durable Object.
- **Elegance**: the least code that is obviously correct. Prefer a well-chosen library over hand-rolled logic for solved problems (dates, time zones, money, parsing, validation). Flag hand-kept data that changes over time (holidays, hours, fee tables) in `src/`.
- **Simplicity (KISS/YAGNI)**: flag speculative options, layers, generic helpers, unused exports and new dependencies without a stated reason.
- **Boundaries**: pure rules in `src/lib/domain/` (no IO, no clock, no Effect); external input decoded with Effect `Schema`; typed errors; no `any`, non-null `!` or unchecked `as`.
- **Runtime fit**: no `Bun.*` or `bun:*` in Worker code (`src/`, `engine/`, except `*.test.ts` using `bun:test`); no Node-only APIs without `nodejs_compat` support; imports use `#lib/*` (SvelteKit 3 removed `$lib`).
- **Tests**: every domain rule has `bun:test` unit tests including the worked examples in the docs; engine changes touching reservations, ledgers or reconciliation include a concurrency test; bug fixes start with a failing test.
- **Docs**: behavior changes update the matching file in `docs/` in the same PR.

## Don't comment on

- Formatting and lint style (Prettier and ESLint enforce them), generated files (`worker-configuration.d.ts`, `bun.lock`), or Spanish UI copy that matches `designs/`.
- Missing features that belong to other open issues; the PR body says which issue it closes.

Be concise: one comment per real problem, with the fix. Say when something is fine rather than inventing suggestions.
