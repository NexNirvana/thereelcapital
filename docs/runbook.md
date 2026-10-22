# Operations runbook

How to run the pilot. It links to the docs that own each rule instead of repeating them. Commands run from the repository root on the owner's machine, with `wrangler` logged in to the Cloudflare account (`bunx wrangler login`). Items marked **not built** or **not verified** are not described as working.

## SIM only, always

No TradeStation call may spend real money ([CLAUDE.md](../CLAUDE.md)). Only `https://sim-api.tradestation.com/v3` is used. To check:

- `git grep -n "api.tradestation.com" -- ':!docs'` lists every mention of the live host outside `docs/`. Only the OAuth audience constant and test fixtures may appear (the allow list is in `.githooks/no-live-host`).
- The `pre-commit` hook blocks a new line naming the live host, and the `guards` job in `.github/workflows/policy.yml` re-runs the check over every commit of a pull request ([CONTRIBUTING.md](../CONTRIBUTING.md#hooks)).
- The adapter refuses any URL whose origin is not the SIM API ([tradestation-integration.md](tradestation-integration.md#adapter-enginesrctradestation)).

If anything seems to need live access, stop and ask the owner.

## First admin and admin lockout

Neither command needs a secret ([D32](decisions.md)).

```sh
bun run admin:create <email> --remote
bun run admin:recover <email> --remote
```

- `admin:create` inserts the admin, an activation link and an `admin.create` audit row in one D1 batch, and prints the link once. Share it personally; opening it starts passkey registration. Without `--remote` it writes the local database.
- `admin:recover` is for the last admin who lost every passkey. It removes the admin's passkeys, recovery codes and sessions, revokes open links, and prints a new link once. It refuses an unknown email, a non-admin and a disabled admin.
- With two or more admins, recover the other one from `/admin/administradores/[id]` instead.
- A link is valid for the hours printed with it. If it expires, run `admin:recover` again for an admin who already exists. If the first registration failed after the link was spent, run `admin:recover` as well.

Details: [auth-and-security.md](auth-and-security.md#flows).

## Clients from `/admin`

Every action needs an admin session under 10 minutes old. On `REAUTH_REQUIRED`, use «Confirmar con passkey» and repeat. Each action writes an audit row. Screens: [screens-and-flows.md](screens-and-flows.md#admin).

| Task | Where |
| --- | --- |
| Create a client | `/admin`, create form. The activation link appears once; copy it and share it personally (the app sends no email) |
| New link (client has no passkey yet) | `/admin/clientes/[id]`, generate or revoke link |
| Deactivate or reactivate | `/admin/clientes/[id]`. Sessions end and sign-in is blocked; broker orders and positions are not touched |
| Revoke sessions | `/admin/clientes/[id]`, one session or all |
| Recover a client (lost passkey and codes) | `/admin/clientes/[id]`, controlled recovery. Verify identity outside the app first, then tick «Verifiqué la identidad del cliente fuera de la app». Passkeys, codes and sessions are deleted and a new link is issued |
| Change SIZE, stop %, unlock % | `/admin/clientes/[id]`. SIZE only goes up; values apply to new entries and positions |

## Secrets

Set with `wrangler secret put`, which prompts for the value so it never appears on the command line or in logs. Never print, commit or paste a value. Names only are in `.dev.vars.example`.

| Secret | Worker | Set with |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | `reel-web` | `bunx wrangler secret put BETTER_AUTH_SECRET -c wrangler.jsonc` |
| `CREDENTIALS_KEY` | `reel-engine` only | `bunx wrangler secret put CREDENTIALS_KEY -c engine/wrangler.jsonc` |
| `CREDENTIALS_KEY_PREVIOUS` | `reel-engine` only, only during a rotation | `bunx wrangler secret put CREDENTIALS_KEY_PREVIOUS -c engine/wrangler.jsonc` |

Generate a value with `openssl rand -base64 32` (the format `CREDENTIALS_KEY` requires). CI also holds `CLOUDFLARE_API_TOKEN` (secret) and `CLOUDFLARE_ACCOUNT_ID` (variable) for the `deploy` job; rotate the token in Cloudflare and update the GitHub secret.

**Rotating `BETTER_AUTH_SECRET`.** Every pending recovery code stops working, because codes and audit IP hashes are keyed with it. Activation links and passkeys are unaffected. Session signing also depends on it; treat all sessions as ended (**not verified**). Clients then need their recovery codes re-issued, so rotate only for a suspected leak, and warn the pilot clients first. See [auth-and-security.md](auth-and-security.md#flows).

**Rotating `CREDENTIALS_KEY`.** Each stored credential carries a `key_id` (a fingerprint of the key that sealed it). During a rotation the engine also accepts `CREDENTIALS_KEY_PREVIOUS`: it decrypts a row with whichever of the two keys its `key_id` names, always encrypts with `CREDENTIALS_KEY`, and re-encrypts a row still on the previous key at its next token refresh. Clients stay connected and nobody presses «Reconectar con TradeStation». A secret cannot be read back from Cloudflare, so the old value must come from wherever you stored it when you created it.

1. In one shell session, keeping the values out of the terminal output and shell history (`set +o history`), with the old value in `OLD_KEY` (read from your password manager) and a new one generated:

   ```sh
   NEW_KEY=$(openssl rand -base64 32)     # store it in the password manager now
   printf %s "$OLD_KEY" | bunx wrangler secret put CREDENTIALS_KEY_PREVIOUS -c engine/wrangler.jsonc
   printf %s "$NEW_KEY" | bunx wrangler secret put CREDENTIALS_KEY -c engine/wrangler.jsonc
   unset OLD_KEY NEW_KEY
   ```

   Set PREVIOUS first so there is no moment where rows are unreadable. Each `secret put` deploys a new engine version. Both values must be base64 of 32 bytes, and `wrangler` does not check that. If refreshes start failing for every client (`CREDENTIALS`, or `CREDENTIALS_UNAVAILABLE` on connect) right after the change, a value is malformed, and either one can be at fault. Re-set `CREDENTIALS_KEY` first with the value it should have (the one you just generated, or the old key from the password manager; do not generate another one here, because rows already re-encrypted under the current key would be stranded), then `CREDENTIALS_KEY_PREVIOUS`. Keep `CREDENTIALS_KEY_PREVIOUS` set until the failure is understood: deleting it while rows still use it makes those rows fail (`KEY_UNKNOWN`, then `EXPIRED`) until the client presses «Reconectar con TradeStation». While a secret value is malformed, reconnecting does not help.
2. Wait until every row is on the new key. Count them by `key_id`; the new key's id is the one that grows, and only an empty old group means done:

   ```sh
   bunx wrangler d1 execute DB --remote -c wrangler.jsonc \
     --command "SELECT key_id, COUNT(*) AS connections FROM broker_connection GROUP BY key_id"
   ```

   A client's row moves on its next successful token refresh. A client with a stale or expired connection stays on the old id until it reconnects, which stores the new one.
3. Delete the old key: `bunx wrangler secret delete CREDENTIALS_KEY_PREVIOUS -c engine/wrangler.jsonc`.

If a row's `key_id` matches neither key (for example PREVIOUS was deleted too early or set wrong), the refresh records `broker.refresh_failed` with reason `KEY_UNKNOWN`, the connection shows as expired, entries are blocked and open positions show `unverified`; that client must press «Reconectar con TradeStation». Exits and cancels are never blocked by this. See [tradestation-integration.md](tradestation-integration.md#token-lifetime) and [auth-and-security.md](auth-and-security.md#secrets).

Losing `CREDENTIALS_KEY` without a backup forces every client to reconnect (as above, for all rows).

## Deploys

Deploys run only from CI on `main` (the `deploy` job in `.github/workflows/ci.yml`). Never deploy by hand.

Order: `bunx wrangler d1 migrations apply DB --remote`, then the engine Worker, then the web Worker, then a smoke check that `https://thereelcapital.com/acceso` serves «Entrar con passkey» (retried for two minutes). Details: [architecture.md](architecture.md#configuration-and-deploy).

**Migrations.** D1 migrations are the numbered files in `migrations/`; the Durable Object class migration is the `migrations` entry in `engine/wrangler.jsonc`. Both are applied by `deploy`. Write D1 migrations so the previous Worker version still runs against them, because the migration is applied before the new code.

**When `main` is red:**

1. `scripts/pr-status.sh <pr>` for a pull request; `gh run list --branch main --limit 5` and `gh run view <run-id> --log-failed` for `main`.
2. A failed check or test stops `deploy` before anything changes. Fix forward with a `fix/` or `hotfix/` branch ([CONTRIBUTING.md](../CONTRIBUTING.md#branches)).
3. If `deploy` failed after the migration step, the database is already migrated. Fix forward; the next push re-runs the job (the migrations step skips what is applied).
4. If the smoke check failed but the Workers deployed, check the Cloudflare dashboard (custom domain, Worker errors) before re-running the job.

**Rollback.** `bunx wrangler rollback -c wrangler.jsonc` (and `-c engine/wrangler.jsonc`) returns a Worker to its previous version. **Not yet exercised** in this project. It does not undo D1 migrations, so prefer fixing forward through CI.

## Reading the audit log and history

- Read-only admin pages (admins only; [screens-and-flows.md](screens-and-flows.md#admin)):
  - `/admin/auditoria`: the audit log, 50 per page, newest first, with actor, action, target, time and before → after. Filters by actor, action, target and dates (New York days) combine. Credential-like values are masked.
  - `/admin/operativa`: every client's connection state, open positions, pending orders, protection and UNKNOWN orders, as each client's engine reports them. A client whose engine does not answer shows «No disponible» and the others still show. Nothing can be sent or cancelled from it.
  - `/admin/historial`: orders and events across clients, 25 orders per page. Filters by client, account, symbol, state, type and dates. Events come with the first page only. A client whose engine fails is listed in an alert.
- Fallback if the admin pages are unavailable: read the audit log in D1. It stores no secrets (`at` is epoch milliseconds):

  ```sh
  bunx wrangler d1 execute DB --remote --command "SELECT datetime(at/1000,'unixepoch') AS at_utc, actor_id, action, target_user_id, before_json, after_json FROM audit_log ORDER BY at DESC LIMIT 50"
  ```

- Orders, fills and events live in each client's Durable Object, not in D1. The client sees theirs in `/historial`; the admin sees all clients in `/admin/historial`.
- Retention: 6 years for orders, fills, events and audit, and no deletion code exists (D22 in [decisions.md](decisions.md)). Do not delete rows by hand.
- D1 backup: Time Travel restore is **not verified** in this project; check the Cloudflare D1 documentation before relying on it.

## Connecting a client's TradeStation key

By default (decision D35) the client connects by pasting the address of the localhost page that does not load; nothing has to be registered on their key (`CONNECT_REDIRECT_MODE`, `src/lib/domain/config.ts`). Tell them: save the key and secret on `/conexion`, log in at TradeStation in the tab that opens, allow, then copy the whole address of the next page (it will not load, which is expected) and paste it into the field «Dirección copiada». If it fails with «No reconocemos esa dirección», the address must start with `http://localhost:3000`; with «El enlace de autorización no es válido o venció», the 10 minute window passed or it was already used, so start again. A key that rejects `http://localhost:3000` (callbacks edited by TradeStation) needs registered mode. Never ask a client to send you the pasted address: it holds a one-time code.

## Connecting a TradeStation account when the holder is on another computer

For when the person who owns the TradeStation account (the holder) is not at the owner's computer. The owner runs the app side; the holder only logs in at TradeStation. This is the D35 paste mode, split between two people.

1. **Owner:** sign in to the app, open `/conexion`, save the API key and secret, and press «Conectar». Do not log in at TradeStation. Copy the address of the `signin.tradestation.com/authorize` tab that opens, and send it to the holder. Keep that browser and tab open.
2. **Holder:** open the address, log in at TradeStation (password and 2FA), and allow access. The next page, `http://localhost:3000/?code=…&state=…`, will not load; that is expected. Send the whole address in the browser's address bar back to the owner.
3. **Owner:** paste it into «Dirección copiada» on `/conexion`, in the same browser and within 10 minutes of pressing «Conectar» (`ATTEMPT_TTL_MS`, `engine/src/connection.ts`). The app then lists the accounts; check that the account is a SIM account.

Safety notes:

- The authorize address carries the API key (`client_id`), never the secret. Sharing it is harmless on its own.
- The `code` in the returned address is single use and short lived, and is useless without the API secret, which only the engine holds. Still, send it only to the owner, and delete the message after pasting.
- The holder never shares their TradeStation password or 2FA codes with anyone. They type them only on `signin.tradestation.com`.

If it fails:

- **«El enlace de autorización no es válido o venció»:** the attempt is older than 10 minutes, was already used, or the address was pasted in another browser or session (the `state` is single use and bound to the session). Press «Conectar» again, send the new authorize address, and repeat from step 2. Addresses from an earlier attempt never work.
- **TradeStation rejects the login or the key:** the API key may belong to a different TradeStation account than the one the holder logs in with. Not verified against TradeStation; confirm with the holder which account the key was created under.

Local development (`http://localhost:8787/conexion`) and production are separate connections: each stores its own tokens, so each needs its own round of these steps.

The SIM spike (#21) works the same way with `bun run spike accounts --paste` on the owner's machine: it prints the authorize address to send to the holder and waits for the returned `localhost` address on stdin. The spike keeps its tokens in memory only, so it is a separate login from the app's; run each step during one call with the holder ([tradestation-integration.md](tradestation-integration.md#spike-checklist-sim-regular-session)).

## Broker incidents

What the engine does on its own is in [order-lifecycle.md](order-lifecycle.md#degraded-states) and [tradestation-integration.md](tradestation-integration.md#token-lifetime). Summary and what to check:

| Situation | Automatic behavior | Admin checks |
| --- | --- | --- |
| Client's connection `expired` or `revoked` (the key's 24 h lifetime ended, or TradeStation refused the refresh) | Entries blocked, positions `unverified`, no further refresh until reconnect. Exits and cancels are not blocked by the hold | Ask the client to press «Reconectar con TradeStation». After reconnecting, entries stay blocked until the sync loop reconciles |
| `reconciliation_pending` (after a failed refresh, connect or disconnect) | Entries blocked. Only a successful reconciliation (`markReconciled`) lifts it | Wait a sync tick with the app open. If it persists, check the connection status on `/admin/clientes/[id]` or `/admin/operativa` and ask the client to reconnect |
| UNKNOWN order (timeout or unclear answer on place) | Never retried. Both reservations held and the position `unverified` until reconciliation matches it to a broker order by `OrderID` or `OrderConfirmID`. Several candidates stay UNKNOWN and log `reconcile.ambiguous` | Do not tell the client to resend. Ask them to check the order in TradeStation; the next reconciliation resolves it. A persistent one is escalated to the owner |
| TradeStation outage (5xx, timeouts) | `sync.broker_error`: entries blocked, retried every tick, `sync.recovered` lifts the hold | Check TradeStation's status page; nothing to do |
| 429 | `sync.rate_limited`: waits the reset time from `X-RateLimit-Reset`; the order is not placed and the reservation is released | Limits are per client key; repeated 429s point to something polling too often |

Events are listed per client in `/historial` and across clients in `/admin/historial`. Server-side logs: `bunx wrangler tail reel-engine` (logs events, never secrets).

**Protection:** stops are engine-held (D36): each sync tick compares fresh bids with the stop level and sells `available` at MARKET; a stale or failing quote or token shows `unverified`, and a rejected stop waits `STOP_REJECTED_COOLDOWN_MS` before a new one. Trailing (#29) is not built yet.

**Not built or not verified:** the SIM spike (#21, `bun run spike`) has not produced results, so the refused-refresh answer, token lifetime counting and several order behaviors are unconfirmed ([tradestation-integration.md](tradestation-integration.md#spike-checklist-sim-regular-session)).

## CI incidents

- **Jobs stay queued.** The repository variable `CI_RUNNER` points the jobs at the owner's machine. If the machine is off or no runner is registered, jobs wait forever. Switch back to GitHub-hosted runners, then re-run the jobs:

  ```sh
  scripts/ci-runner/toggle.sh off
  ```

  `toggle.sh on` switches back and refuses unless `ci.yml` keeps fork pull requests and `deploy` off the runners. Install and removal: `scripts/ci-runner/setup.sh` and `scripts/ci-runner/uninstall.sh` ([CONTRIBUTING.md](../CONTRIBUTING.md#self-hosted-runner)).
- **Flaky tests.** e2e runs as three shards; the required `e2e` check fails if any shard failed. Re-run only the failed jobs (`gh run rerun <run-id> --failed`). If the same test flakes twice, open an issue; do not merge on a red check.
- **Wait for a pull request.** `scripts/pr-status.sh <pr> --wait`.

## Related

[architecture.md](architecture.md), [auth-and-security.md](auth-and-security.md), [order-lifecycle.md](order-lifecycle.md), [tradestation-integration.md](tradestation-integration.md), [open-questions.md](open-questions.md).
