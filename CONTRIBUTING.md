# Contributing

## Setup

```sh
git config core.hooksPath .githooks
git config user.name  "OnishellT"
git config user.email "46875497+OnishellT@users.noreply.github.com"
```

Once the project is scaffolded, `pnpm install` sets the hooks path automatically.

## Workflow

1. Every change starts from a GitHub issue.
2. Branch from `main`: `<type>/<issue>-<slug>`, e.g. `feat/22-entry-orders`, `fix/27-oversell-race`.
3. Open a PR early. Its title follows the commit format below, and its body says `Closes #<issue>`.
4. CI must pass. Merge with **squash**; the PR title becomes the commit on `main`. The branch is deleted on merge.
5. A PR does one thing. If it grows past one issue, split it.
6. Behavior changes update the relevant `docs/` file in the same PR.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), checked by the `commit-msg` hook and in CI.

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

- Every rule in `src/lib/domain/` has unit tests, including the worked examples in the docs.
- Engine changes touching reservations, ledgers or reconciliation include a concurrency test.
- A bug fix starts with a failing test.
- Tests name the behavior: `rejects a fourth entry on the same market day`.

### Dependencies

- Add one only when it removes real complexity, and say why in the PR. Pin exact versions. Prefer platform APIs (WebCrypto, `fetch`, `Intl`).
