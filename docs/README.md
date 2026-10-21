# REEL CAPITAL docs

Engineering reference for `thereelcapital.com`: an invitation-only terminal where clients trade equities and long options in their own TradeStation accounts with their own API key, MARKET orders only, regular session only, SIM first.

| Doc | Covers |
| --- | --- |
| [product-spec.md](product-spec.md) | purpose, roles, parameters, scope, journey, modes |
| [domain-rules.md](domain-rules.md) | sizing, limits, guards, scale-outs, stop, trailing, calendar (pure functions) |
| [order-lifecycle.md](order-lifecycle.md) | intents, idempotency, atomicity, the sell ledger, reconciliation, degraded states |
| [architecture.md](architecture.md) | Workers, Durable Object, data model, repo layout, config and deploy |
| [auth-and-security.md](auth-and-security.md) | Better Auth setup and its gaps, flows, sessions, secrets, isolation |
| [tradestation-integration.md](tradestation-integration.md) | OAuth, tokens, endpoints, order body, status mapping, limits, spike checklist |
| [design-system.md](design-system.md) | tokens, type, shell, components |
| [screens-and-flows.md](screens-and-flows.md) | client and admin routes |
| [test-plan.md](test-plan.md) | test layers, cases, SIM acceptance |
| [decisions.md](decisions.md) | superseded rules, product and technical decisions |
| [open-questions.md](open-questions.md) | what is still undecided or unverified |

## Precedence

1. [`ONBOARDING.md`](../ONBOARDING.md): the user's confirmed decisions (Spanish). It wins; if a doc disagrees, fix the doc.
2. Final designs in [`desings/`](../desings/) (folder name sic) for layout and copy.
3. These docs.
4. The PDFs, superseded where they conflict ([decisions.md](decisions.md)).
5. The demo HTMLs, for interaction ideas only.

## Source files

| Path | What it is |
| --- | --- |
| `ONBOARDING.md` | confirmed decisions, source of truth |
| `REEL_CAPITAL_Proyecto_Integral.pdf`, `REEL_CAPITAL_Informe_Para_Programador.pdf` | first specs (16 Oct 2026), partly superseded |
| `REEL_CAPITAL_DASHBOARD_DEMO.html`, `references/REEL_CAPITAL_PRIVATE_TERMINAL.html` | offline demos; the second shows the two-position and shared-bar model |
| `references/REEL_CAPITAL_VISUAL_REFERENCE.png` | mood reference only (dark, mono, thin lines), not its content |
| `references/TRADESTATION_API_APPROVAL.md` | API key approval text: Auth0 key, v3 auth, 24h refresh note |
| `desings/desktop/*.png`, `desings/mobile/*.png` (+ `.prompt.md`) | final screens and their exact copy |
| `desings/flow/como-funciona.*` | one-page app flow |
| `output/imagegen/` | design explorations, historical; the light and orange variants are rejected |

The figures in the images (`•• 4821`, SPY Call 600, US$4.00) are fictional SIM data. UI copy is Spanish; engineering docs are English.
