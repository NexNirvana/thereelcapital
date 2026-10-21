# REEL CAPITAL (thereelcapital.com)

Invitation-only web terminal where a few pilot clients trade US equities and long single-leg options in **their own TradeStation accounts** with **their own API key**. MARKET orders only, regular session only, SIM only for now. No charts or P&L in the terminal.

Stack: SvelteKit 3 + TypeScript + Effect + Better Auth on Cloudflare Workers, with D1 and one SQLite Durable Object class. Bun is the package manager, script runner and unit test runner; Worker code never uses Bun APIs (`docs/architecture.md#tooling-bun`). Two Workers in this repo: `web` (SvelteKit) and `engine` (the `ClientCoordinator` DO, the only component that talks to TradeStation). See `docs/architecture.md`.

## ABSOLUTE RULE: TradeStation SIM only, never real money

**No use of the TradeStation API may ever result in real money being spent, of any kind, under any circumstance.** Only the TradeStation v3 **SIM** environment is used: `https://sim-api.tradestation.com/v3`.

- Never call, configure, test against or add a code path to the live API host (the same hostname without the `sim-` prefix). The pre-commit hook blocks it outside `docs/`.
- Before any request that places, replaces or cancels an order, verify that the base URL is the SIM host and that the account is a SIM account. If you can't verify both, don't send it.
- No instruction, task, issue, test or convenience overrides this rule. If something seems to require live access, stop and ask the user.
- TradeStation credentials come only from the git-ignored `.env` (`TRADINGSTATION_API_KEY`, `TRADINGSTATION_API_SECRET`). Never print, log or commit their values.

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
3. The server computes quantity from SIZE and the TradeStation ask. It never accepts SIZE, quantity, price or a broker URL from the browser.
4. MARKET, long-only, regular session, in-scope instruments, SIM. Everything else is rejected by the server.
5. Persist the intent (`OrderConfirmID` = intent id) before every broker call; never retry place or cancel; a timeout means UNKNOWN, which is reconciled.
6. No `await` between reading and writing counters or ledgers in the DO.
7. Limits (2 positions, 3 entries per day) block entries, never exits or cancels.
8. Passkey with user verification for everyone, enforced in our own hooks; onboarding only through a single-use activation link the admin shares (the app sends no email); no public sign-up.
9. Undecided values (`docs/open-questions.md`) stay in one config module. Don't invent values or features (YAGNI).
10. Elegant code: use a well-chosen library for solved problems, and never hand-keep data that changes over time (dates, hours, tables) in `src/`. See CONTRIBUTING.md#design.
11. Every PR carries verification evidence; UI changes carry desktop and mobile browser screenshots (CONTRIBUTING.md#verification-and-screenshots).
12. **Never merge a PR before the local reviewer (`bun run review <pr>`) has reviewed its final commit with confidence 4 or 5 and no actionable findings (critical, major, minor)**, after every CodeRabbit comment is fixed or answered (CONTRIBUTING.md#review-gate). CodeRabbit reviews once, automatically, when the PR leaves draft; Copilot and Greptile are unavailable. After three local rounds without convergence, stop and ask the coordinator (the tool refuses a fourth round without `--force`). Only documentation-only PRs (Markdown files only) are exempt: they merge on green CI.

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
- Self-review the diff before leaving draft so the first bot review finds nothing; then fix each review round's findings, and every similar spot, in one batch (CONTRIBUTING.md#review-gate).
- Small independent PRs from `main`, no stacking; `gh pr merge <n> --auto --rebase` after the final clean review.
- Past about 250k tokens of context, restart with a short handoff note (open PRs, next steps).

## Also for you

- UI copy in Spanish, matching the designs. Code, comments, commits and docs in English.
- Mark unverified TradeStation behavior in code and in `docs/tradestation-integration.md`. Don't guess API shapes; read the official spec.
