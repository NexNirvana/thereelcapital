# Contributing

## Setup

```sh
git config core.hooksPath .githooks
git config user.name  "OnishellT"
git config user.email "46875497+OnishellT@users.noreply.github.com"
```

Install [Bun](https://bun.com) at the version in `package.json` (`packageManager`), plus a Node LTS for the Node-based tools. Once the project is scaffolded, `bun install` also sets the hooks path.

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
- Title in the commit format below; body starts with `Closes #<issue>` and fills in the template.
- Open it early as a draft; mark it ready when the commits are organized and CI passes.
- Keep the branch current by rebasing on `main` (`git rebase origin/main`), never by merging `main` into it.
- Merge with **Rebase and merge**. Each commit lands on `main` exactly as organized, and history stays linear. The branch is deleted on merge.
- Behavior changes update the relevant `docs/` file in the same PR.

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

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), checked by the `commit-msg` and `pre-push` hooks and, for every commit of a PR, in CI.

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
- **pre-push**: rejects pushes to `main`, branch names outside the table above, and any pushed commit whose message breaks the rules.

Don't bypass them with `--no-verify`. If a hook is wrong, fix the hook.

## Code guidelines

### Design

- **Simple first.** Write the most direct code that meets the issue. No speculative options, layers or generic helpers. Three similar lines beat a premature abstraction.
- **One owner per piece of state.** Order state lives in the `ClientCoordinator` DO; identity and settings live in D1. Never copy state between them.
- **Pure core, thin shell.** Rules live in `src/lib/domain/` as pure functions. Routes, the DO and adapters decode input, call the rules, perform IO and map the results.
- **Make illegal states unrepresentable.** Prefer discriminated unions and branded types (`Mode`, `IntentState`, `Quantity`) over booleans and loose strings.
- **Fail loudly and early.** Decode every external input with Effect `Schema` at the boundary. Inside the boundary, trust the types.

### TypeScript

- `strict` on; no `any`, no non-null `!` and no `as` casts outside decoders. `// @ts-expect-error` only with a reason.
- Name things for the domain: `availableQty`, `stopLevel`, `sessionDate`, not `data`, `info` or `helper`.
- Small modules with one purpose and named exports. No barrel files that re-export everything.
- Money and quantities: integer cents and integer quantities (or the decimal type chosen in `src/lib/domain`); never compare floats for equality.
- Dates: pass `now` in. Market logic uses America/New_York via the calendar module, never the runtime's local time.

### Effect

- Use it in server code and the engine for `Schema`, typed errors (`Data.TaggedError`) and services (`Context.Tag` + `Layer`) for things with IO: the broker, the clock, the email sender.
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

- Add one only when it removes real complexity, and say why in the PR. Use `bun add` (exact versions via `bunfig.toml`) and commit `bun.lock`. No other package manager or lockfile.
- Prefer platform APIs (WebCrypto, `fetch`, `Intl`).

### Bun

- Bun runs installs, scripts, `bun test` and `scripts/*.ts`. Bun-native APIs (`Bun.$`, `Bun.file`, `Bun.write`, `Bun.CryptoHasher`, `bun:test`) belong only in `scripts/` and unit tests.
- Worker code (`src/`, `engine/`) runs in workerd: never import `bun:*` or use `Bun.*` there, and never import from `scripts/`.
- Don't run Node CLIs with `--bun`; let them run on Node.
