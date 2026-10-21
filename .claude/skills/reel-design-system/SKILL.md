---
name: reel-design-system
description: Use when building or reviewing any REEL CAPITAL UI (Svelte components, routes, CSS) — access/passkey, Nueva entrada, option chain, review, Posiciones, Historial, Conexión, admin.
---

# REEL CAPITAL UI

Before building a screen, open its PNG in `desings/desktop/` and `desings/mobile/` and its `.prompt.md` (exact Spanish copy). Then use `docs/design-system.md` (tokens, type, shell, components) and `docs/screens-and-flows.md` (routes and contents).

## Checklist

- Colors only from the tokens in `src/lib/ui/tokens.css`. Dark only; no other hues, gradients or shadows.
- IBM Plex Mono only (self-hosted). Hierarchy from size, weight and case; numbers use `tabular-nums`.
- Data sits in hairline-separated rows on the background, not in cards. One filled primary button per view.
- Always visible: mode badge, account, connection state, `x/2 posiciones · y/3 entradas hoy`, protection state (`Activo` only when verified).
- Never: charts, P&L, editable SIZE/quantity/price, SIZE DOWN, demo test buttons.
- Disabled controls state why. Pending order states are visible and not re-clickable.
- Every value shown comes from the server; components don't compute quantities.
- Plain Svelte components and CSS; no Effect, no CSS framework.
- Accessible: semantic buttons, visible focus, `aria-live` for order state changes, ≥44px touch targets.
- Check at about 1440px and about 390px against the PNGs. Long Spanish strings in a monospace face must wrap cleanly.
