# REEL CAPITAL docs

Engineering reference for `thereelcapital.com`: an invitation-only terminal where clients trade equities and long options in their own TradeStation accounts with their own API key, MARKET orders only, regular session only, SIM first.

## How to read these docs

Start with [product-spec.md](product-spec.md) for what the product is, then [architecture.md](architecture.md) for how it is built. Open the other docs when you touch their area: each rule has one owning doc, and the others link to it instead of restating it. [decisions.md](decisions.md) explains why a rule is what it is; [open-questions.md](open-questions.md) lists what is still unverified. Facts that are not confirmed against the broker are marked **(verify)**.

## The docs

| Doc | Covers |
| --- | --- |
| [product-spec.md](product-spec.md) | purpose, roles, parameters, scope, journey, modes |
| [domain-rules.md](domain-rules.md) | sizing, limits, guards, scale-outs, stop, trailing, calendar (pure functions) |
| [order-lifecycle.md](order-lifecycle.md) | intents, idempotency, atomicity, the sell ledger, reconciliation, degraded states |
| [architecture.md](architecture.md) | Workers, Durable Object, data model, repo layout, config and deploy |
| [auth-and-security.md](auth-and-security.md) | Better Auth setup and its gaps, flows, sessions, secrets, isolation |
| [tradestation-integration.md](tradestation-integration.md) | OAuth, tokens, endpoints, order body, status mapping, engine-held protection, limits, spike checklist and tooling |
| [design-system.md](design-system.md) | tokens, type, shell, components |
| [screens-and-flows.md](screens-and-flows.md) | client and admin routes |
| [test-plan.md](test-plan.md) | test layers, cases, SIM acceptance |
| [runbook.md](runbook.md) | operating the pilot: admin recovery, secrets, deploys, connecting a client's key, broker and CI incidents |
| [decisions.md](decisions.md) | superseded rules (D1–D14), product decisions (D18 onward), technical decisions (T1 onward) |
| [open-questions.md](open-questions.md) | what is still undecided or unverified (answered items move to decisions.md) |

## Precedence

1. [`ONBOARDING.md`](../ONBOARDING.md): the user's confirmed decisions (Spanish). It wins; if a doc disagrees, fix the doc.
2. Final designs in [`designs/`](../designs/) for layout and copy.
3. These docs.
4. The PDFs, superseded where they conflict ([decisions.md](decisions.md)).
5. The demo HTMLs, for interaction ideas only.

## Elsewhere in the repository

| Path | What it is |
| --- | --- |
| [`ONBOARDING.md`](../ONBOARDING.md) | the owner's confirmed decisions (Spanish); first in the precedence order |
| [`CLAUDE.md`](../CLAUDE.md) | short orientation and the non-negotiable rules for coding agents |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | workflow, review gate, commit format, hooks, code guidelines |
| `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | review rules, general and scoped by path; the local reviewer reads them |
| `.claude/skills/*/SKILL.md` | task checklists for agents (`reel-trading`, `tradestation-integration`, `reel-design-system`, `reel-security-review`); they point to these docs |
| [`engine/test/fixtures/README.md`](../engine/test/fixtures/README.md) | where each TradeStation test fixture comes from |

## Source files

| Path | What it is |
| --- | --- |
| `ONBOARDING.md` | confirmed decisions, source of truth |
| `references/REEL_CAPITAL_Proyecto_Integral.pdf`, `references/REEL_CAPITAL_Informe_Para_Programador.pdf` | first specs (16 Oct 2026), partly superseded |
| `references/REEL_CAPITAL_DASHBOARD_DEMO.html`, `references/REEL_CAPITAL_PRIVATE_TERMINAL.html` | offline demos; the second shows the two-position and shared-bar model |
| `references/REEL_CAPITAL_VISUAL_REFERENCE.png` | mood reference only (dark, mono, thin lines), not its content |
| `references/TRADESTATION_API_APPROVAL.md` | API key approval text: Auth0 key, v3 auth, 24h refresh note |
| `designs/desktop/`, `designs/mobile/` (PNG + `.prompt.md`) | final screens and their exact copy |
| `designs/flow/como-funciona.*` | one-page app flow |
| `designs/explorations/` | design explorations, historical; the light and orange variants are rejected |

The figures in the images (`•• 4821`, SPY Call 600, US$4.00) are fictional SIM data. UI copy is Spanish; engineering docs are English.
