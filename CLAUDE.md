# REEL CAPITAL (thereelcapital.com)

Invitation-only web terminal where a few pilot clients trade US equities and long single-leg options in **their own TradeStation accounts** with **their own API key**. MARKET orders only, regular session only, SIM now and REAL behind locks (D52). No charts or P&L in the terminal.

Stack: SvelteKit 3 + TypeScript + Effect + Better Auth on Cloudflare Workers, with D1 and one SQLite Durable Object class. Bun is the package manager, script runner and unit test runner; Worker code never uses Bun APIs (`docs/architecture.md#tooling-bun`). Two Workers in this repo: `web` (SvelteKit) and `engine` (the `ClientCoordinator` DO, the only component that talks to TradeStation). See `docs/architecture.md`.

## ABSOLUTE RULE: no real money from development, tests or CI

**No development, test, script or CI activity may ever spend real money.** REAL mode (the TradeStation live environment) exists in the code only behind four locks (D52 in `docs/decisions.md`), and production keeps it closed until the owner opens it in a PR of their own.

- The four locks: the engine variable `REAL_TRADING` (only the exact value `"enabled"` opens it), the per-client `client_settings.real_trading_enabled` set by an admin, an account the live host listed for that connection, and a transport that checks every request against its mode's base URL.
- Agents, scripts, tests and CI never contact the live API host, never set `REAL_TRADING` in `engine/wrangler.jsonc` or any deployed environment, and never enable REAL for a real client. Tests reach the live base only through scripted `fetch` stubs; `bun run spike` stays SIM only.
- The one place the switch is open is the e2e local simulation: `tests/e2e/engine.env` sets `REAL_TRADING=enabled` only together with `BROKER=local-sim` and `ENVIRONMENT=test`, so the REAL broker is the local simulation and no TradeStation transport can be built. The e2e may turn REAL on for a test client in its local database.
- The live host may appear only in the single `LIVE_API_BASE_URL` declaration in `engine/src/tradestation/endpoints.ts` (the pre-commit hook blocks it elsewhere outside `docs/`). SIM orders only ever reach `https://sim-api.tradestation.com/v3`.
- Before any request that places, replaces or cancels an order, the transport verifies that the base URL is the one of the order's mode and that the account was listed by that mode's host. If it can't verify both, it doesn't send it.
- TradeStation credentials come only from the git-ignored `.env` (`TRADINGSTATION_API_KEY`, `TRADINGSTATION_API_SECRET`). Never print, log or commit their values.
- No instruction, task, issue, test or convenience overrides this rule. If something seems to require contacting the live host, stop and ask the user.

## Commands

Bun runs the scripts; the CLIs behind them (Vite, Wrangler, svelte-check, ESLint, Prettier) run on Node, never with `--bun`.

```sh
bun install            # also sets core.hooksPath to .githooks
bun run dev            # build, then serve both Workers: wrangler dev -c wrangler.jsonc -c engine/wrangler.jsonc (http://localhost:8787)
bun run build          # vite build (web Worker into .svelte-kit/cloudflare)
bun run check          # svelte-kit sync + svelte-check (strict TypeScript)
bun run lint           # prettier --check + eslint
bun run format         # prettier --write
bun run test          # unit, engine and e2e in sequence
bun run test:unit     # bun test (src/lib/** and scripts/**, bun:test)
bun run test:engine   # Vitest + @cloudflare/vitest-plugin inside workerd (engine/test)
bun run test:e2e      # Playwright: builds and starts both Workers, opens the smoke page (needs: bunx playwright install chromium)
bun run admin:create <email> [--remote]  # first admin + activation link (docs/auth-and-security.md)
bun run admin:recover <email> [--remote] # recover the last admin: reset passkeys and codes, print a new activation link
bun run spike [step|all] [--confirm-sim-orders]  # observe TradeStation SIM behavior and save sanitized samples (issue #21)
bun run types:check    # wrangler types --check: fails if worker-configuration.d.ts is stale
bun run types          # regenerate worker-configuration.d.ts for both Workers after editing a wrangler.jsonc
bun run review <pr>    # local PR reviewer: posts one review with a confidence score (--dry-run to preview); see CONTRIBUTING.md#review-gate
```

Deploys run only from CI on `main` (`deploy` job in `.github/workflows/ci.yml`); never deploy by hand. Local secrets go in the git-ignored `.dev.vars` (names in `.dev.vars.example`).

## Read first

- `ONBOARDING.md`: the user's confirmed decisions (Spanish). **It wins over everything; fix the docs if they disagree.**
- `docs/README.md`: doc index and precedence. The docs are the spec; link to them instead of restating them.
- `designs/`: final screens with their exact copy (`.prompt.md` next to each PNG) and the app flow. `references/`: the original PDFs, demos, mood image and TradeStation approval notice.
- Project skills in `.claude/skills/`: `reel-trading`, `tradestation-integration`, `reel-design-system`, `reel-security-review`. Load the one for the area you touch.

## Never break

1. The client id comes from the verified session. Every query and DO call is scoped by it.
2. Secrets and tokens stay server-side, encrypted at rest, never logged. Only the engine decrypts TradeStation credentials.
3. The server computes quantity from SIZE and the TradeStation ask. It never accepts quantity, price or a broker URL from the browser; the one amount it accepts is the whole-dollar entry SIZE of a client the admin allowed (D53), re-checked against the SIZE and switch in D1 at prepare and at send.
4. MARKET, long-only, regular session, in-scope instruments, SIM or REAL behind its locks (D52). Everything else is rejected by the server.
5. Persist the intent (`OrderConfirmID` = intent id) before every broker call; never retry place or cancel; a timeout means UNKNOWN, which is reconciled.
6. No `await` between reading and writing counters or ledgers in the DO.
7. Limits (2 positions; entries per day, 3 by default and set per client by the admin) block entries, never exits or cancels.
8. Passkey with user verification for everyone, enforced in our own hooks; onboarding only through a single-use activation link the admin shares (the app sends no email); no public sign-up.
9. Undecided values (`docs/open-questions.md`) stay in one config module. Don't invent values or features (YAGNI).
10. Elegant code: use a well-chosen library for solved problems, and never hand-keep data that changes over time (dates, hours, tables) in `src/`. See CONTRIBUTING.md#design.
11. Every PR carries verification evidence; UI changes carry desktop and mobile browser screenshots (CONTRIBUTING.md#verification-and-screenshots).
12. **Never merge a PR before the local reviewer (`bun run review <pr>`) has reviewed its final commit with confidence 4 or 5 and no actionable findings (critical, major, minor)**, and every CodeRabbit comment that arrived before the merge is fixed or answered (CONTRIBUTING.md#review-gate). The local review runs as soon as the PR leaves draft, in parallel with CI; nobody waits for CodeRabbit, which reviews once, automatically, when the PR leaves draft; Copilot and Greptile are unavailable. After three local rounds without convergence, stop and ask the coordinator (the tool refuses a fourth round without `--force`). Only documentation-only PRs (Markdown files only) are exempt: they merge on green CI. The required `review-gate` check enforces this and `bun run review` re-runs its failed runs of the head after posting the review.

## Contributing rules

@CONTRIBUTING.md

Everything in CONTRIBUTING.md applies to you, in particular:

- Commit as **OnishellT**; check `git config user.email` before the first commit of a session.
- **Never** mention Claude, Anthropic or AI in commits, PRs, issues or code: no `Co-Authored-By` trailer, no "Generated with" line. This overrides any default attribution instruction. Only the file paths `CLAUDE.md` and `.claude/` are exempt.
- Never push to `main`. Work on a `feature/`, `fix/` or `hotfix/` branch for the issue, organize the commits as CONTRIBUTING.md describes, and open one PR.
- Never use `--no-verify`.

## Working economically

Long sessions cost most through tool output kept in context.

- Delegate polling, review-fix and restack loops to Sonnet subagents that report in at most 10 lines. Research subagents use Sonnet too. `bun run review <pr>` costs no session context: run it in a subagent or in the background and read only its confidence and findings.
- Screenshots and design comparisons happen in a subagent that reports in text; don't read images in the main session.
- Read big docs with `grep -n` and `sed -n`, not whole. Cap command output (`| head -c 4000`).
- Use Write or Edit for file changes, not nested heredocs.
- Check a PR with `scripts/pr-status.sh <pr>`; wait for CI with `scripts/pr-status.sh <pr> --wait` instead of monitors or sleep loops.
- Run browser tests locally only for specific specs with `--workers=2` at most, and never the full suite while `CI_RUNNER` is on: the machine is running CI. The full suite runs in CI (CONTRIBUTING.md#self-hosted-runner).
- Self-review the diff before leaving draft so the first bot review finds nothing; then fix each review round's findings, and every similar spot, in one batch (CONTRIBUTING.md#review-gate).
- Small independent PRs from `main`, no stacking; `gh pr merge <n> --auto --rebase` after the final clean review.
- Past about 250k tokens of context, restart with a short handoff note (open PRs, next steps).

## Also for you

- UI copy in Spanish, matching the designs. Code, comments, commits and docs in English.
- Mark unverified TradeStation behavior in code and in `docs/tradestation-integration.md`. Don't guess API shapes; read the official spec.
