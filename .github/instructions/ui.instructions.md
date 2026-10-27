---
applyTo: "src/routes/**/*.svelte,src/lib/ui/**"
---

# UI (Svelte 5)

Spec: `docs/design-system.md`, `docs/screens-and-flows.md`; designs in `designs/desktop/` and `designs/mobile/`.

- Colors only from `src/lib/ui/tokens.css`; dark only; no gradients, shadows or other hues. IBM Plex Mono only, self-hosted; numbers use `tabular-nums`.
- Never show charts, P&L, balances, or editable SIZE, quantity or price. Mode badge, account, connection, `x/2 posiciones · y/N entradas hoy` and protection state stay visible where the design shows them; "Activo" only for a verified protection.
- One filled primary button per view; disabled controls state why; pending order states are visible and can't be clicked again.
- Components render server data and send user intents; they never compute quantities or decide permissions. No Effect in components; no CSS framework.
- Accessibility: semantic elements, labels, visible focus, `aria-live` for order state changes, touch targets of at least 44px.
- Links use `resolve()` from `$app/paths`; imports use `#lib/*`.
- UI copy is Spanish and matches the designs' `.prompt.md` files.
