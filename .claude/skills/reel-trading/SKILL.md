---
name: reel-trading
description: Use when implementing, testing or reviewing REEL CAPITAL trading logic — the pure rules in src/lib/domain (sizing, limits, order guards, scale-out steps, stop, trailing, market calendar) or the ClientCoordinator Durable Object (intents, reservations, sell ledger, sync loop, reconciliation).
---

# REEL CAPITAL trading

Read the relevant section first; these docs are the spec, so don't restate them in code comments:

- `docs/domain-rules.md`: formulas and the scale-out table (encode it as tests).
- `docs/order-lifecycle.md`: intent states, rules, reconciliation, degraded states.
- `docs/product-spec.md#parameters`: values, and who may change them.

## Traps that are easy to get wrong

- Domain functions take `now`, quotes and settings as arguments. No `Date.now()`, IO or Effect services inside `src/lib/domain/`.
- Quantities and percentages use the **confirmed** `sold_qty`, never clicks, pending orders or `done_zero` steps.
- `stop_pct`, `trailing_unlock_pct` and `size_applied` are read from the **position or intent**, not from the client's current settings.
- No `await` between reading and writing counters, slots or the ledger: use `ctx.storage.transactionSync`.
- Persist the intent (with its `OrderConfirmID`) **before** calling TradeStation. Never retry place or cancel; a timeout means UNKNOWN.
- Limits block entries only. Exits and cancels are blocked only by session hours, auth loss or an UNKNOWN intent on that position.
- A slot frees when the broker reports zero remaining or when the position's own recorded exit fills sold all of it (shared account, D49), never on an ALL OUT click.
- Undecided values (trailing set, stop/unlock bounds) live in one config module. Don't invent new ones; check `docs/open-questions.md`.
- Adding to an open position is rejected until the user defines it.
- The local-sim broker is «simulación local»; passing against it is not TradeStation verification.

## Tests required with any change

Unit tests (`bun test`) for every rule touched, and an engine test (Vitest + `@cloudflare/vitest-plugin`) for any reservation, ledger or reconciliation change, including the concurrent case.
