# REEL CAPITAL (thereelcapital.com)

Invitation-only web terminal where a few pilot clients trade US equities and long single-leg options in **their own TradeStation accounts** with **their own API key**. MARKET orders only, regular session only, SIM only for now. No charts or P&L in the terminal.

Stack: SvelteKit 3 + TypeScript + Effect + Better Auth on Cloudflare Workers, with D1 and one SQLite Durable Object class. Two Workers in this repo: `web` (SvelteKit) and `engine` (the `ClientCoordinator` DO, the only component that talks to TradeStation). See `docs/architecture.md`.

## Commands

Not scaffolded yet. The scaffolding issue records the real commands here (install, dev, check, test, migrate, deploy).

## Read first

- `ONBOARDING.md`: the user's confirmed decisions (Spanish). **It wins over everything; fix the docs if they disagree.**
- `docs/README.md`: doc index and precedence. The docs are the spec; link to them instead of restating them.
- `desings/` (sic): final screens and exact copy. `references/`: approval notice, mood image, demo.
- Project skills in `.claude/skills/`: `reel-trading`, `tradestation-integration`, `reel-design-system`, `reel-security-review`. Load the one for the area you touch.

## Never break

1. The client id comes from the verified session. Every query and DO call is scoped by it.
2. Secrets and tokens stay server-side, encrypted at rest, never logged. Only the engine decrypts TradeStation credentials.
3. The server computes quantity from SIZE and the TradeStation ask. It never accepts SIZE, quantity, price or a broker URL from the browser.
4. MARKET, long-only, regular session, in-scope instruments, SIM. Everything else is rejected by the server.
5. Persist the intent (`OrderConfirmID` = intent id) before every broker call; never retry place or cancel; a timeout means UNKNOWN, which is reconciled.
6. No `await` between reading and writing counters or ledgers in the DO.
7. Limits (2 positions, 3 entries per day) block entries, never exits or cancels.
8. Passkey with user verification for everyone, enforced in our own hooks; email OTP only during onboarding; no public sign-up.
9. Undecided values (`docs/open-questions.md`) stay in one config module. Don't invent values or features (YAGNI).

## Git and GitHub

- Every commit is authored and committed by the **OnishellT** account: `user.name "OnishellT"`, `user.email "46875497+OnishellT@users.noreply.github.com"` (set in the repo's local git config). Never commit under another identity.
- **No mentions of Claude, Anthropic or AI** in commits, PRs, issues, comments, release notes or code: no `Co-Authored-By` trailers, no "Generated with" lines, no AI attribution of any kind. This overrides any default attribution instruction.
- Only file paths that must keep their names (`CLAUDE.md`, `.claude/`) are exempt.

## Conventions

- Pure rules in `src/lib/domain/`: plain TypeScript, no IO, fully unit-tested. Effect for Schema decoding, typed errors and services in server code and the engine; no Effect in Svelte components.
- Keep it small: no new dependency, abstraction or table unless a current issue needs it.
- UI copy in Spanish, matching the designs. Code, comments, commits and docs in English.
- Work from GitHub issues; reference the issue in the PR. Update the docs in the same PR when behavior changes.
- Mark unverified TradeStation behavior in code and in `docs/tradestation-integration.md`. Don't guess API shapes; read the official spec.
