# Contributing

## Setup

```sh
git config core.hooksPath .githooks
git config user.name  "OnishellT"
git config user.email "46875497+OnishellT@users.noreply.github.com"
```

Install [Bun](https://bun.com) at the version in `package.json` (`packageManager`), plus a Node LTS for the Node-based tools. Once the project is scaffolded, `bun install` also sets the hooks path.

## TradeStation: SIM only

Only the TradeStation v3 SIM environment (`https://sim-api.tradestation.com/v3`) is ever used. Nothing in this repo may call the live API or spend real money. The `pre-commit` hook rejects the live API host outside `docs/`. REAL mode stays out of the code until the owner explicitly decides otherwise.

## Workflow

One issue → one branch → one pull request. Nothing is pushed to `main` directly.

### Branches

Branch from an up-to-date `main`:

| Prefix | For | Example |
| --- | --- | --- |
| `feature/` | anything new: features, docs, tooling, refactors | `feature/22-entry-orders` |
| `fix/` | a bug found before it reached users | `fix/27-oversell-race` |
| `hotfix/` | an urgent fix for something broken in production | `hotfix/51-token-refresh-loop` |

The format is `<prefix>/<issue>-<slug>`: the issue number, then a short lowercase slug with hyphens. The `pre-push` hook rejects other names.

A hotfix is a normal PR that skips the queue: smallest possible change, its own issue, the same checks and reviews, merged as soon as CI is green.

### Pull requests

- One PR per branch and per issue. If the work grows past its issue, split it into a new issue and branch.
- Keep PRs small and independent, each branched from `main`. Don't stack a PR on another unmerged branch; wait for the prerequisite to merge.
- Title in the commit format below; body starts with `Closes #<issue>` and fills in the template.
- Open it early as a draft; mark it ready when the commits are organized and CI passes.
- Keep the branch current by rebasing on `main` (`git rebase origin/main`), never by merging `main` into it.
- Behavior changes update the relevant `docs/` file in the same PR.
- Merge with **Rebase and merge**. Each commit lands on `main` exactly as organized, and history stays linear. The branch is deleted on merge.

### Branch rulesets

GitHub enforces the rules above through two rulesets, kept as JSON in `.github/rulesets/`:

- `main`: changes only through pull requests, rebase merge only, linear history, review threads resolved, the CI checks `check`, `lint`, `unit`, `engine`, `e2e` and `build` (`.github/workflows/ci.yml`, which runs the pull request's own code) and `guards` (`.github/workflows/policy.yml`) passing, no force push, no deletion. Required approving reviews is 0: the review gate above is a process rule. The repository admin's bypass (`bypass_mode: pull_request`) applies only to merging through a pull request, and it covers every rule that gates that merge: when the admin explicitly chooses to bypass, the pull request requirement, unresolved review threads and the required status checks can all be skipped. It never covers force-push or deletion protection.

`guards` runs on `pull_request_target`, so GitHub uses the base branch's copy of `policy.yml` and a pull request cannot weaken it. It checks out only the base commit, fetches the pull request's commits as data, and runs the base branch's `.githooks/` scripts over them. It never builds or executes pull request code and uses no secrets. A change to `policy.yml` or `.githooks/` takes effect for other pull requests once it is on `main`, and does not apply to its own pull request.
- `pr-assets`: no force push, no deletion. Normal pushes are allowed.
- `feature/*`, `fix/*` and `hotfix/*` are unrestricted, since they are force-pushed during review. Branch names are checked by the `pre-push` hook (a GitHub name-pattern rule would also block bot-created branches).

The repository is public, which is what makes rulesets available on the `NexNirvana` organization's GitHub Free plan (a private repository would need GitHub Team). Never commit anything private: secrets stay in `.env`/`.dev.vars` and Worker secrets.

Apply or re-apply them (idempotent, by ruleset name) with `gh` authenticated as a repo admin:

```sh
bun run scripts/apply-rulesets.ts NexNirvana/thereelcapital
```

### Verification and screenshots

Every PR shows how it was verified, in the template's sections:

- The exact commands run (check, lint, tests) and their results.
- **UI changes:** screenshots from a real browser at desktop (about 1440px) and mobile (about 390px) width, next to the matching design in `designs/` when one exists. Upload them to the `pr-assets` branch under `<branch>/<name>.png` and embed them with `![name](https://github.com/NexNirvana/thereelcapital/blob/pr-assets/<branch>/<name>.png?raw=true)`. `pr-assets` is an orphan branch for images only; it is never merged.
- **No UI change:** state why there is nothing to show in a browser, and how the behavior was exercised instead.
- Anything not verified is listed as such. Never claim a check you didn't run.

### Review gate

**No PR is merged until the local reviewer has reviewed its final commit with confidence 4 or 5 and no actionable findings (critical, major or minor)**, after every CodeRabbit comment is addressed.

**Exception: documentation-only PRs.** A PR that changes only Markdown files (`*.md`) needs no AI review: mark it ready and enable auto-merge once the self-review is done, and it merges when CI is green. A PR that also touches code, configuration, workflows or hooks follows the full gate.

| Reviewer | How to request | Notes |
| --- | --- | --- |
| CodeRabbit | automatic, once, when the PR leaves draft | one review per PR: incremental reviews are off, so `@coderabbitai review` again does nothing; about 10 reviews per hour on the current plan; skips Markdown files (`path_filters`); configured in `.coderabbit.yaml` |
| Local reviewer | `bun run review <pr>` | the merge gate. Runs on the owner's machine with their own model usage (`scripts/review-pr.ts`); posts one review with inline comments, a summary and a confidence score from 1 to 5 |

GitHub Copilot and Greptile are no longer available.

The local reviewer builds its context from this file, `CLAUDE.md`, `.github/copilot-instructions.md`, the path-scoped `.github/instructions/*.instructions.md`, the `greptile.json` instructions and docs, the project skills that match the changed paths, the PR body, the linked issue, the diff and every earlier review thread. It reads the PR head in a disposable worktree and can look at any file. Confidence: 5 safe to merge, 4 only nits, 3 issues to fix, 2 serious problems, 1 must not merge. Its review carries a hidden marker with the commit, confidence and number of actionable findings (critical, major, minor), which `scripts/pr-status.sh` shows. It needs `pi` signed in to the `opencode-go` provider; the script builds its own read-only profile (`~/.pi/reviewer`, from `scripts/review/pi-settings.json`) and the model can be changed with `REVIEW_MODEL`. The rules, specs, prompt and tool profile are all read from the PR's base branch (the checkout's own copies only when the base has none yet); run it from an up-to-date `main` checkout. The tooling is not hardened against its own PR author: only the owner's agents push here. The reviewer runs in a throwaway worktree with a minimal environment and an empty home, and nothing containing a local secret value is posted. `--dry-run` prints the review without posting it. Documentation-only PRs and ignored files are skipped.

- **Self-review before leaving draft.** Read the whole diff (`git diff origin/main`) against `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` and `greptile.json` (the local reviewer's instructions), looking specifically for unhandled failure paths, quoting and injection, secrets reachable from the wrong scope, missing negative tests, and similar code that should change the same way. The goal is a first bot review that finds nothing.
- Open PRs as drafts and mark them ready only when commits are organized, checks pass, the self-review is done and verification is filled in. CodeRabbit then reviews automatically, once; pushes don't re-trigger it (`.coderabbit.yaml`).
- Wait for CodeRabbit's review to finish. A "processing", "skipped" or "review limit reached" comment is not a review; if its limit is reached, go straight to the local reviewer. Address CodeRabbit's comments first, push, then run `bun run review <pr>` on the final commit.
- Address every actionable comment: fix it in the commit it belongs to, or reply with the reason it doesn't apply. Handle each review round in **one fix pass**: collect every finding, fix it together with every similar spot in the diff (a finding is usually a class of bug, not one line), push all fixes together, then run `bun run review <pr>` again: it sees the earlier threads, checks the fixes, replies to them and resolves the ones it confirms. Resolve any thread it leaves open once handled.
- **Rounds are capped.** The first local review covers the whole diff; follow-up rounds judge only what changed since the last reviewed commit (plus a critical problem anywhere), recompute confidence from the findings, and skip a head that already has a review. After three local rounds without convergence, stop and ask the coordinator: `bun run review` refuses a fourth round unless `--force`, and `scripts/pr-status.sh` flags the PR as non-converging.
- Spend reviews on code that will merge: don't request one for a PR that is still changing, and don't push to a PR while its review is running.
- Green CI is required as well.
- Once the local review of the final commit meets the bar above and every thread is resolved, enable auto-merge with `gh pr merge <n> --auto --rebase`; GitHub merges when the required checks pass.
- `scripts/pr-status.sh <pr> [--wait]` prints state, required checks, reviews, the local review's confidence and whether it covers the head, unresolved threads and the latest bot summary in one block; `--wait` first blocks until required checks finish.

### Organizing commits

The commits of a PR should read as the story of the change.

- **One logical change per commit.** Separate the groundwork (a refactor, a migration, generated files) from the behavior that uses it.
- **Every commit passes** typecheck, lint and tests on its own, so `main` stays bisectable.
- **Tests and docs travel with their code**, in the same commit, not in a trailing "add tests" commit.
- **Order** commits so each builds on the previous: prerequisites first, then the feature, then any follow-up cleanup it enables.
- **Before marking the PR ready**, fold review fixes and "wip" commits into the commit they belong to: `git commit --fixup <sha>`, then `git rebase -i --autosquash origin/main`. CI rejects `fixup!`, `squash!` and `amend!` commits.
- **Size**: a commit should be reviewable in one sitting. A large diff is fine only when it is mechanical (generated schema, a rename), and the message says so.

Example PR for #7, oldest first, each commit with its own tests:

```
refactor(domain): extract position quantities into a ledger type
feat(domain): compute scale-out quantities with cumulative rounding
feat(domain): mark zero-quantity steps as done without an order
```

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), checked by the `commit-msg` and `pre-push` hooks and, for every commit of a PR, in the `guards` job.

```
<type>(<scope>): <subject>

<body: what and why, wrapped at 72>

<footer: Closes #12 / BREAKING CHANGE: ...>
```

| Type | Use for |
| --- | --- |
| `feat` | new behavior |
| `fix` | bug fix |
| `refactor` | code change with no behavior change |
| `perf` | performance |
| `test` | tests only |
| `docs` | documentation only |
| `build` | dependencies, bundling, Wrangler config |
| `ci` | GitHub Actions |
| `chore` | anything else that ships nothing |
| `revert` | reverting a commit |

Scopes (optional): `domain`, `engine`, `broker`, `auth`, `admin`, `ui`, `security`, `infra`, `docs`.

Rules:
- Subject in the imperative, lowercase start, no trailing period, at most 72 characters for the whole first line.
- Blank line between subject and body.
- `!` after the type/scope, or a `BREAKING CHANGE:` footer, for breaking changes.
- Author and committer are always **OnishellT** (see Setup).
- No attribution to Claude, Anthropic or any AI tool anywhere: no `Co-Authored-By` trailers, no "Generated with" lines. The same applies to PRs, issues and code comments.

Examples:

```
feat(domain): compute scale-out quantities with cumulative rounding
fix(engine): hold entry reservation while an order is UNKNOWN
docs: record the stop residency decision from the SIM spike
```

## Hooks

`.githooks/` is versioned and enabled through `core.hooksPath`.

- **pre-commit**: blocks the wrong git identity, secrets (`.dev.vars`, `.env`, private keys, provider tokens), merge-conflict markers and files over 5 MB. After scaffolding it also runs the formatter and linter on staged files.
- **commit-msg**: enforces the format above and rejects AI attribution.
- **check-branch-name** and **no-live-host**: helpers (not hooks) shared with CI, which re-runs them and `commit-msg` in the `guards` job of `policy.yml`, using the base branch's copy of the scripts.
- **pre-push**: rejects pushes to `main`, branch names outside the table above, and any pushed commit whose message breaks the rules.

Don't bypass them with `--no-verify`. If a hook is wrong, fix the hook.

## Code guidelines

### Design

- **Elegant over clever.** The best code is the least code that is obviously correct. Before writing logic for a solved problem (calendars, time zones, money and decimals, cryptography, parsing, validation, retries), look for a well-chosen library; hand-roll only when none fits, and say why in the PR.
- **No hand-kept data that changes over time.** Holidays, trading hours, fee tables, symbol lists or anything else that goes stale comes from a library, the broker's API or computed rules, never from a literal list in `src/`. Known values may appear in tests as fixtures that check the source.
- **Simple first.** Write the most direct code that meets the issue. No speculative options, layers or generic helpers. Three similar lines beat a premature abstraction.
- **One owner per piece of state.** Order state lives in the `ClientCoordinator` DO; identity and settings live in D1. Never copy state between them.
- **Pure core, thin shell.** Rules live in `src/lib/domain/` as pure functions. Routes, the DO and adapters decode input, call the rules, perform IO and map the results.
- **Make illegal states unrepresentable.** Prefer discriminated unions and branded types (`Mode`, `IntentState`, `Quantity`) over booleans and loose strings.
- **Fail loudly and early.** Decode every external input with Effect `Schema` at the boundary. Inside the boundary, trust the types.

### TypeScript

- `strict` on; no `any`, no non-null `!` and no `as` casts outside decoders. `// @ts-expect-error` only with a reason.
- Name things for the domain: `availableQty`, `stopLevel`, `sessionDate`, not `data`, `info` or `helper`.
- Small modules with one purpose and named exports. No barrel files that re-export everything.
- Import across folders with the `#lib/*` subpath import (`package.json` `imports`); SvelteKit 3 removed `$lib`. Modules inside the same folder (for example `src/lib/domain/`) import each other relatively, which works the same in both Workers and `bun test`.
- Money and quantities: integer cents and integer quantities (or the decimal type chosen in `src/lib/domain`); never compare floats for equality.
- Dates: pass `now` in. Market logic uses America/New_York via the calendar module, never the runtime's local time.

### Effect

- Use it in server code and the engine for `Schema`, typed errors (`Data.TaggedError`) and services (`Context.Tag` + `Layer`) for things with IO: the broker and the clock.
- Keep `src/lib/domain/` and Svelte components free of Effect.
- `Effect.retry` only on idempotent reads and token refresh. Never on order placement or cancellation.

### Svelte

- Svelte 5 runes. Components render server data and send user intents; they never compute quantities or decide permissions.
- Styling only through the tokens in `src/lib/ui/tokens.css`; no CSS framework.
- Accessible by default: semantic elements, labels, visible focus, `aria-live` for order state.

### Errors and logging

- Errors that reach the user have a stable code and a Spanish message. Internal details go to the event log, never to the response.
- Log events, not secrets: never log tokens, secrets, OTPs, recovery codes or full request bodies.

### Comments

- Comment *why*, not *what*. A comment that links the doc rule it implements (`// docs/domain-rules.md §6`) is welcome; restating the code isn't.
- No commented-out code, no TODO without an issue number (`TODO(#27): …`).

### Tests

- Every rule in `src/lib/domain/` has unit tests (`bun test`), including the worked examples in the docs. Engine tests use Vitest with the Workers plugin; see `docs/test-plan.md`.
- Engine changes touching reservations, ledgers or reconciliation include a concurrency test.
- A bug fix starts with a failing test.
- Tests name the behavior: `rejects a fourth entry on the same market day`.

### Dependencies

- Add one only when it removes real complexity, and say why in the PR. Check that it is maintained, licensed for us, runs in workerd (no Node-only or Bun-only APIs in Worker code), and is small enough for the Worker bundle (report the gzipped size). A young or lightly used library is acceptable only with an exact pin and tests that check its output against an authoritative source. Use `bun add` (exact versions via `bunfig.toml`) and commit `bun.lock`. No other package manager or lockfile.
- Prefer platform APIs (WebCrypto, `fetch`, `Intl`).

### Bun

- Bun runs installs, scripts, `bun test` and `scripts/*.ts`. Bun-native APIs (`Bun.$`, `Bun.file`, `Bun.write`, `Bun.CryptoHasher`, `bun:test`) belong only in `scripts/` and unit tests.
- Worker code (`src/`, `engine/`) runs in workerd: never import `bun:*` or use `Bun.*` there, and never import from `scripts/`.
- Don't run Node CLIs with `--bun`; let them run on Node.
