---
applyTo: "src/lib/domain/**"
---

# Domain rules (`src/lib/domain/`)

Spec: `docs/domain-rules.md`. These are pure functions called by the engine; they are the single implementation of each rule.

- No IO, no `Date.now()` or other clock reads, no randomness, no Effect, no imports from `src/lib/server`, `engine/` or `scripts/`. `now`, quotes and settings are parameters.
- Money and prices are integer micro-dollars (`money.ts`), never floats; quantities are integers. Flag floating-point arithmetic on money.
- Results are discriminated unions with closed reason unions, not thrown errors (throwing is only for programmer errors such as an invalid micro-dollar value).
- Quantities count only confirmed fills: `sold_qty`, never clicked, pending or `done_zero` steps. `available = original − sold − committed`.
- Scale-out steps use cumulative half-up rounding on the original quantity (§6); check new code against the worked table in the doc and its tests.
- Stop and trailing use the percentages stored on the position, not the client's current settings.
- Entry and slot limits never apply to exits or cancels.
- The market calendar comes from the `market-calendar` library; dates may appear only as test fixtures.
- Tests use `bun:test`, fixed `now` values, and cover every rejection reason.
