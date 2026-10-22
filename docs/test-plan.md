# Test plan

| Layer | Tool | Runs against |
| --- | --- | --- |
| Unit | `bun test` | `src/lib/domain/`, Schema decoders, crypto helpers: anything pure that runs on web-standard APIs |
| Engine | Vitest + `@cloudflare/vitest-plugin`, launched with `bun run`, running on Node and executing tests inside workerd | `ClientCoordinator` DO + D1 with the local-sim broker, including fault injection |
| End-to-end | Playwright (on Node) | both Workers under `wrangler dev`, local-sim broker, a virtual WebAuthn authenticator |
| Broker SIM | manual checklist + scripted smoke | TradeStation SIM during regular session |

Only `bun test` runs on Bun; the engine and e2e layers need Node because their tools do. Unit tests import from `bun:test`, while engine tests import from `vitest`. The two runners are never mixed in one file. The local-sim broker reproduces failures; it never counts as TradeStation verification. CI runs the first three on every PR.

## Unit

- **Sizing**: options with point values other than 100; equities with increment > 1; missing/stale/halted quote, missing symbol details and qty below minimum all block with their reason.
- **SIZE**: increase accepted; equal or lower rejected.
- **Scale-outs**: the table in [domain-rules.md §6](domain-rules.md#6-scale-out-steps) for 1, 7, 37, 50, 80, 137, 200; the five 10% steps pressed out of order; `done_zero` steps; pending quantities subtracted; never above `available`.
- **Protection**: stop level from the average fill price and the stored %; trailing eligibility from `sold_qty` only (pending and `done_zero` don't count); trail level never decreases; effective level = max(stop, trail).
- **Guards**: each rejection in §5 (REAL, foreign account, futures, spread, non-MARKET, SELLTOOPEN, BUYTOCLOSE, oversell, outside session, second position on the same symbol); trailing % outside the allowed set; stop/unlock % outside bounds.
- **Calendar**: weekends, NYSE holidays, early closes, DST changes, session date at 00:00–09:30 ET.

## Engine (DO)

- **Daily limit**: 4 concurrent entries across 2 accounts → exactly 3 reserve; a reject or zero-fill cancel releases; a partial fill keeps; UNKNOWN holds; a DO restart and a reconnect don't reset; the next session date renews; exits don't return entries.
- **Slots**: 2 open + a pending third → rejected; a slot is freed only when the broker reports zero remaining.
- **Idempotency**: the same intent sent twice → one broker order (same `OrderConfirmID`); a new intent → a new order.
- **Races**: stop vs ALL OUT vs pending scale-out vs trailing never oversell; a cancel racing a fill ends in the broker's state.
- **UNKNOWN**: a place timeout → UNKNOWN → reconcile → no resend.
- **Reconciliation**: external orders and positions adopted; existing activity at first connect counted.
- **Settings**: admin changes affect only new entries and positions.
- **Mode**: SIM and REAL data never mix; REAL is rejected.
- **Degraded states**: each row of the [degraded-states table](order-lifecycle.md#degraded-states).

### Local-sim broker

`engine/src/broker/local-sim/` implements the same `BrokerAdapter` service as the TradeStation adapter, in memory and without any network call. Time comes from an injected `now` and order ids from a `seed`, so a scenario replays identically. It is labelled «simulación local» (`LOCAL_SIM_LABEL`, on every account it returns). It is selected only with `BROKER=local-sim` and `ENVIRONMENT` set to `development` or `test`; a missing or production `ENVIRONMENT` refuses it (`engine/src/broker/select.ts`). The Playwright specs run both Workers this way: `tests/e2e/engine.env` (passed with `--env-file`) selects it and sets `TEST_NOW`, which pins the engine's clock inside a regular session and is ignored anywhere else (`engine/src/clock.ts`). `bun run test:e2e` (`scripts/e2e.ts`) gives each run its own free ports and its own wrangler state directory (`tests/e2e/ports.ts`; `E2E_PORT_BASE` pins them), so several runs can share a machine. The specs seed D1 rows and a client's SIM accounts, orders and positions (`seedTradingClient`, because only a real TradeStation connection fills them) through the running app: `POST /api/test/seed` writes D1 and calls the client's Durable Object (`seedForTest`), and both answer only when `ENVIRONMENT` is `development` or `test` (404 and `NOT_AVAILABLE` otherwise). No second process writes the databases, which is what raced their locks (`SQLITE_BUSY`).

Fills are `instant`, `partial` (some now, the rest later or never) or `delayed`. Faults are queued with `inject` and each fires once (or `times` times):

| Fault | What the engine sees |
| --- | --- |
| `dropPlaceResponse` | the order exists, the caller gets `Timeout` |
| `rejectAfterAck` | the place is acknowledged, the next read shows REJECTED with no fill |
| `fillRacesCancel` | the cancel is refused because the order filled first |
| `quoteStale`, `quoteMissing` | a delayed quote with an old trade time, or no quote for the symbol |
| `authExpired`, `rateLimited` | `AuthExpired` or `RateLimited` (with or without a retry hint) on the next call, optionally of one operation |

A repeated `OrderConfirmID` returns the order it already made; whether TradeStation rejects or returns the original is unverified (**verify** in the SIM spike).

## Security

- Public sign-up → rejected. No route sends email.
- Passkey registration or sign-in without UV → rejected (virtual authenticator with UV off), and no passkey or session is created (`tests/e2e/passkey.spec.ts`). The authenticator is driven over CDP; a test asks for `userVerification: "discouraged"` so the authenticator really answers UV=0 and the server's own check is what rejects it. Users and sessions are seeded into the local D1 by the test through the test-only seed route (see above), never through a product endpoint. A banned user gets the Spanish message and no session.
- Expired, reused or regenerated activation links and used recovery codes → rejected. An enrollment session can only register a passkey. Regenerating or revoking a link after its enrollment session started makes that session's passkey registration fail; opening one link twice leaves only the newest enrollment session usable. Recovery revokes all sessions, deletes all the client's passkeys in the same batch (the old passkey can no longer sign in; other clients are untouched; the deletion is audited) and allows only passkey enrollment; another unused code retries an interrupted recovery.
- Client A can't read or act on client B through any route (the ids in requests are ignored).
- Admin routes reject clients. Admin changes need a fresh session and write `audit_log`. Impersonation and password endpoints → 404.
- Banning a client revokes sessions and leaves broker orders untouched.
- No secrets in responses, logs or the client bundle (CI greps the build output for known secret names and token patterns).
- Protections keep running after logout.

## Broker SIM acceptance (first delivery)

1. Admin creates a client (SIZE 20,000) → copies the activation link → the client opens it → passkey → recovery codes → own key → OAuth → SIM account.
2. In session: MARKET BUY of a stock and BUYTOOPEN of a contract from the chain, both auto-sized from the live ask.
3. Fills shown; a partial exit with the bar; ALL OUT; history visible after signing in again.
4. A pending order cancelled while the broker still allows it.
5. Admin raises SIZE → the next entry uses it; other clients and existing orders are unchanged.
6. A 4th entry the same day is rejected, also from another account or tab; exits still work.
7. The 30% stop acts on the remainder and survives a reconnect; a new admin % applies only to new positions.
8. A 3rd position is rejected. Trailing unlocks only after confirmed sales.
9. The ask is read-only, cleared on contract change, and missing data is shown; the execution price comes from fills.
10. A revoked token blocks entries, shows protection unverified, and reconnecting reconciles.
11. Click → send → ack → fill timestamps recorded from intents for review. SIM fills are instant, so this is not a LIVE latency estimate.
