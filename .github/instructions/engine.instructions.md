---
applyTo: "engine/**"
---

# Engine Worker (`engine/`)

Spec: `docs/order-lifecycle.md`, `docs/architecture.md`, `docs/tradestation-integration.md`.

- `ClientCoordinator` (one Durable Object per client, `idFromName(userId)`) is the only component that talks to TradeStation and the only writer of order state. Flag any copy of order state into D1.
- Every row, key and counter is scoped by `mode`; anything but `SIM` is rejected before any IO. The only broker base URL is `https://sim-api.tradestation.com/v3`.
- Persist the intent (state ARMED, `OrderConfirmID` = intent id) before calling the broker. Never retry place or cancel (no `Effect.retry` around them); a timeout means `UNKNOWN`, resolved by reconciliation.
- Reservations and ledger updates happen inside `ctx.storage.transactionSync` with no `await` between read and write. Flag read → await → write on counters, slots, steps or quantities.
- Exits go through one ledger per position; never ask for more than `available`. A slot frees when the broker reports zero remaining, or when the position's own recorded exits sold all of it (shared account, D49; the leftover holding is not re-adopted).
- Decode every TradeStation response with Effect `Schema`; map errors to typed failures. Never use positions' P&L fields.
- Credentials are decrypted only here (AES-GCM, `key_id`); never log tokens or secrets.
- Tests run with Vitest + `@cloudflare/vitest-plugin` inside workerd; reservation, ledger and reconciliation changes need a concurrency test; the local-sim broker is never treated as TradeStation verification.
