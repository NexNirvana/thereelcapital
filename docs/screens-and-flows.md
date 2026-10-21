# Screens and flows

The overall flow is in [`designs/flow/como-funciona.svg`](../designs/flow/como-funciona.svg): admin invites and configures → 01 Acceso → 02 Compra → 03 TradeStation returns state and fills → 04 Posición (exits, stop, trailing) → 05 Historial.

Designed screens are reproduced from their PNGs. Undesigned screens use the same shell and components ([design-system.md](design-system.md)). Every screen has explicit loading, empty, error and confirmation states.

## Client

| Route | Screen | Design | Notes |
| --- | --- | --- | --- |
| `/acceso` | Sign in with passkey; link to recovery | `01-access.png` (desktop, mobile) | no password, no sign-up |
| `/activar/[token]` | validate the activation link → register passkey → recovery codes (shown once) | — | one step per view; expired or used links explain how to ask the admin for a new one |
| `/recuperacion` | recovery code → register new passkey → new codes (shown once, with copy) | — (no dedicated design; follows `01-access`) | three steps in one view; a wrong, used or suspended-account code gets one generic error; reloading mid-recovery resumes at the passkey step; the enrollment session lasts 15 minutes |
| `/conexion` | own API key + secret, callback URL to register, connect/reconnect, accounts, mode (SIM; REAL shown disabled), token expiry or «desconocido» | — | |
| `/operar` | Nueva entrada: Acciones / Opciones, instrument, read-only SIZE, ask, quantity, MARKET; summary; `Revisar orden` | `02-new-order.png` | the old quote is cleared on contract change; every disabled state gives its reason (market closed, 3/3, 2/2, quote stale, not verified, qty < 1) |
| `/operar/cadena` | option chain: underlying → expiry → strike × CALL/PUT with bid/ask and freshness | — | opened from «Cambiar contrato»; stream open only while visible |
| `/operar/revisar` | review → send → live intent state (SENT, ACK, PARTIAL, FILLED, REJECTED, UNKNOWN) | — | re-confirm if the server's quantity changed |
| `/posiciones` | switcher (≤2), detail, progress, 7 scale-out steps, protection (stop state, trailing selector + activate), primary `Cerrar posición` (ALL OUT), pending orders with cancel | `03-position.png` | the bar acts only on the selected position |
| `/historial` | orders, states, quantities, fills, cancels, events | — | no P&L |

## Admin

| Route | Screen | Notes |
| --- | --- | --- |
| `/admin` | Clients: list with access and connection status; create client (shows its activation link once, to share personally) | |
| `/admin/clientes/[id]` | Client detail: profile and role; activation link (generate a new one, shown once; revoke); activate/deactivate; sessions (revoke); controlled recovery; settings (SIZE increase-only, stop %, unlock %, each "new entries/positions only"; the 2/3 limits read-only); connection (accounts, status, expiry, last sync; never secrets); open positions and orders | every change needs a fresh session and is audited |
| `/admin/operativa` | all clients: open positions, pending orders, protection state, UNKNOWN intents, entries used today | read-only |
| `/admin/historial` | orders, fills, events and errors across clients; filter by client, mode, account, symbol, state, date, type | |
| `/admin/auditoria` | audit log: actor, action, target, before → after, time; access and invitation events | |

## Not carried over from the demos

`TEST STOP`, `REINICIAR SESIÓN/SIM`, `ACTUALIZAR COTIZACIÓN SIMULADA`, editable «Prima de referencia», `NORMAL / −25% / −50%`, «Stops diarios 0/2». See [decisions.md](decisions.md).
