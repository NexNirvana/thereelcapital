# Architecture

Stack (decided): SvelteKit 3 + TypeScript + Effect on Cloudflare Workers, Better Auth, D1, one SQLite-backed Durable Object class. Version facts below were checked on 2026-10-20. Re-check them when scaffolding.

## Shape

```
Browser ──HTTPS──► web Worker (SvelteKit, adapter-cloudflare 8)
                     │  Better Auth (D1) · pages · form actions · admin
                     │  RPC via DO binding (script_name = reel-engine)
                     ▼
                   engine Worker
                     └─ ClientCoordinator DO  ── one per client ──►  TradeStation API (SIM now, LIVE later)
                          SQLite: intents, positions, counters, events
                          alarms: order/position sync, stop/trailing checks
                   D1 (shared): auth tables, client settings, broker connection, invitations, recovery codes, audit
```

**Two Workers, one repo, one `package.json`.** SvelteKit's generated worker cannot export Durable Object classes or a `scheduled` handler: the adapter docs say so, kit#13692 is open, and the PRs that would add it were closed unmerged. The supported pattern is a second Worker that owns the DO, bound from the web Worker with `script_name`. Post-build hacks that append exports to `_worker.js` are not used.

## Responsibilities

| Unit | Owns | Never does |
| --- | --- | --- |
| `src/lib/domain/` | pure rules: sizing, exits, protection levels, limits, order guards, market calendar | IO, clock reads, Effect services |
| web Worker | sessions and auth (Better Auth), page rendering, input decoding, role checks, admin screens; forwards trading calls to the client's DO | talk to TradeStation; hold order state |
| `ClientCoordinator` DO (`idFromName(userId)`) | **the only TradeStation gateway for that client**: token refresh, accounts, quotes, chain, orders, positions; intents, ledgers, daily counters, slots, scale-out steps, stop/trailing, reconciliation, operational event log; both modes in one store, separated by a `mode` column | trust identifiers from the browser; run when nothing is open (alarms stop) |
| D1 | identity, settings, connection credentials (encrypted), audit | order or position state |

One DO per **client** rather than per (client, mode): one connection serves both modes, so a single owner removes token-refresh races and keeps one place for the per-client limits. Mode isolation is enforced on every row, key and query (`mode` column, mode-prefixed idempotency, separate counters). REAL is rejected at the DO entry point until it is enabled.

## Data model

**D1, Better Auth tables** (`user`, `session`, `account`, `verification`, `passkey`): generated with `bunx auth@latest generate` and applied as D1 migrations. Don't hand-edit them. Add fields through Better Auth config.

**D1, app tables:**

```
client_settings    user_id PK, size_usd, stop_pct, trailing_unlock_pct, updated_at
invitations        id, user_id, token_hash, expires_at, used_at, created_by   -- activation links, shared by the admin
recovery_codes     id, user_id, code_hash, used_at
broker_connection  user_id PK, client_id, client_secret_enc, refresh_token_enc, key_id,
                   refresh_expires_at NULL (= unknown or non-expiring), status, last_ok_at
audit_log          id, at, actor_id, action, target_user_id, before_json, after_json   -- no secrets
```

**DO SQLite** (per client):

```
entry_counters     mode, session_date, consumed, reserved               PK(mode, session_date)
intents            id, mode, kind (entry|exit|stop|trailing|cancel), account_id, position_id,
                   symbol, asset_type, trade_action, qty, size_applied, quote_json, state,
                   order_confirm_id, broker_order_id, filled_qty, avg_fill_price, created_at, updated_at
positions          id, mode, account_id, symbol, underlying, expiry, strike, right, point_value,
                   original_qty, sold_qty, avg_entry_price, stop_pct, trailing_unlock_pct,
                   trailing_pct, trailing_peak, trailing_level, protection_state, status, opened_on
scaleout_steps     position_id, idx (0–6), state (available|pending|done|done_zero), intent_id
events             id, at, mode, level, type, message, data_json   -- operational log and errors, no P&L
```

Fills are not a table: TradeStation reports executed quantity and price per order leg, and the intent stores `filled_qty` and `avg_fill_price` from the broker.

## Runtime behavior

- **Access to bindings**: with adapter-cloudflare 8, server code reads bindings with `import { env } from 'cloudflare:workers'`. (`platform.env` is the 7.x / SvelteKit 2 API.)
- **Calls**: web → `env.ENGINE.getByName(userId).method(args)` (DO RPC). `userId` always comes from the verified session.
- **Sync loop**: while the client has open positions or non-terminal intents, a DO alarm polls TradeStation orders, positions and quotes for protected positions at a fixed interval, within the per-key rate limits. The alarm stops when nothing is open. HTTP streams are not used initially. Adopt them only if the SIM spike shows polling is too slow or option quotes need streams (see [tradestation-integration.md](tradestation-integration.md)).
- **Market calendar**: TradeStation has no calendar endpoint, so sessions, holidays and early closes come from `market-calendar` (NYSE for equities, CBOE equity options for options), wrapped by `src/lib/domain/calendar.ts`.
- **Admin overview**: the web Worker fans out RPC calls to the pilot clients' DOs and merges the results. There is no copied read model. Revisit if the client count grows beyond a few dozen.

## Effect usage

Use Effect where it pays: `Schema` for every external input (requests, TradeStation responses, D1 rows), typed errors, and a `BrokerAdapter` service with a TradeStation implementation and a local-simulation implementation. Domain functions stay plain TypeScript. Svelte components don't use Effect.

## Repository layout

```
src/
  lib/
    domain/            # pure rules + calendar (shared by web and engine)
    schema/            # Effect Schema definitions shared by both Workers
    server/            # web-only server code: auth, guards, audit, engine client (SvelteKit never bundles /server/ into the browser)
    ui/                # Svelte components, tokens.css, fonts
  routes/              # (public) acceso/invitación/recuperación · (app) operar/posiciones/historial/conexion · admin
  hooks.server.ts
engine/
  src/index.ts         # export class ClientCoordinator; default fetch → 404
  src/coordinator/     # DO implementation, SQLite migrations, sync loop
  src/broker/          # BrokerAdapter, tradestation/, local-sim/
  src/crypto.ts        # AES-GCM for credentials
  wrangler.jsonc
migrations/            # D1 SQL (Better Auth generated + app)
static/fonts/          # IBM Plex Mono WOFF2 + OFL
scripts/               # Bun scripts for dev and ops (seed, admin creation, fixture recording)
tests/e2e/             # Playwright
bunfig.toml
wrangler.jsonc         # web Worker
vite.config.ts
```

## Tooling: Bun

Bun is the package manager, script runner and unit test runner. Production code runs in workerd, which has no Bun APIs. Bun's role is therefore:

| Use | How |
| --- | --- |
| Install | `bun install` (text `bun.lock`), `bun ci` in CI. `bunfig.toml`: `install.exact = true`, and a minimum release age as a supply-chain guard |
| Scripts | `bun run <script>`. Node CLIs (Vite, Wrangler, svelte-check, ESLint, Prettier, Vitest, Playwright, the Better Auth CLI) are launched by Bun but run on **Node**. Never pass `--bun` to them: Wrangler and Playwright require Node |
| Unit tests | `bun test` for `src/lib/domain/` and other pure modules |
| Ops scripts | `scripts/*.ts` run on Bun's runtime and may use Bun-native APIs (`Bun.$`, `Bun.file`, `Bun.write`, `Bun.CryptoHasher`) |

**Worker code never uses Bun.** Nothing under `src/` or `engine/` imports `bun:*` or uses `Bun.*`, and `scripts/` is never imported by Worker code. Shared logic uses web-standard APIs (WebCrypto, `fetch`, `Intl`), which work in workerd, Bun and Node.

Versions are pinned through `packageManager: "bun@<version>"` in `package.json`, which `oven-sh/setup-bun` reads. A Node LTS is installed next to it in CI, because the Node CLIs need it.

## Configuration and deploy

- `compatibility_flags: ["nodejs_compat"]` on both Workers (Better Auth needs `AsyncLocalStorage`).
- web `wrangler.jsonc`: `main: ".svelte-kit/cloudflare/_worker.js"`, `assets` binding, D1 `DB`, DO binding `ENGINE` → `ClientCoordinator` with `script_name: "reel-engine"`, route `thereelcapital.com` with `custom_domain: true`.
- engine `wrangler.jsonc`: name `reel-engine`, D1 `DB` (same database), DO class declared as SQLite storage, `workers_dev: false`, no routes.
- Secrets (`wrangler secret put`, never in Git; `BETTER_AUTH_SECRET` is also listed under `secrets.required` so `wrangler types` types it): `BETTER_AUTH_SECRET` (web), `CREDENTIALS_KEY` (engine; web needs it only if it encrypts on save, so prefer encrypting inside the engine), no email key: the app sends no email. Local values in git-ignored `.dev.vars`. `APP_ORIGIN` (public, a `vars` entry in `wrangler.jsonc`) is the origin passkeys are bound to; `.dev.vars` overrides it locally.
- Local dev: `wrangler dev -c wrangler.jsonc -c engine/wrangler.jsonc` after a build; `vite dev` for UI work with the engine running in its own `wrangler dev`.
- CI/CD (GitHub Actions on GitHub-hosted runners, `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-24.04' }}`: free and unlimited for this public repo. Setting the repository variable `CI_RUNNER` to a Blacksmith label moves every job without code changes. `oven-sh/setup-bun@v2` + `actions/setup-node`, `bun ci`): on PRs, typecheck, lint, unit, engine and e2e tests. On `main`, the `deploy` job (needs every check, `environment: production`, group `deploy-production` never cancelled) runs `bunx wrangler d1 migrations apply DB --remote` (web config, which holds `migrations_dir`) → deploy engine → build → deploy web → smoke check of `https://thereelcapital.com`. It authenticates with the `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable; configs never hold the account id.
- Cloudflare Web Analytics is on for the production zone (D26 in [decisions.md](decisions.md)); Cloudflare injects its beacon at the edge, so nothing in the repo loads it and local and e2e runs make no external requests. The beacon is the only off-origin request in production.
- One production environment for the SIM pilot. Add a staging environment only when REAL is being prepared.

## Costs and free-tier limits

The pilot budget is US$0/month (D22): everything runs on free plans.

| Service | Free limit that matters | Pilot use |
| --- | --- | --- |
| Workers (Free) | 100,000 requests/day; 10 ms CPU per request | a few clients; SSR, auth and RPC calls |
| Durable Objects (SQLite, Free) | 100,000 requests/day; 100,000 rows written/day; 5 GB | one object per client; the sync loop runs only while something is open |
| D1 (Free) | 5M rows read and 100,000 written per day; 5 GB | identity, settings, audit |
| Blacksmith, CodeRabbit, Greptile | free tiers | CI and reviews |

Move to Workers Paid (US$5/month) when any of these happen: daily Durable Object requests or rows written pass 70% of the free limit on a normal trading day; requests fail with CPU-limit errors; or the sync loop needs a shorter interval than the free limits allow. Check usage in the Cloudflare dashboard weekly during the pilot.

