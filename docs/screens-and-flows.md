# Screens and flows

The overall flow is in [`designs/flow/como-funciona.svg`](../designs/flow/como-funciona.svg): admin invites and configures → 01 Acceso → 02 Compra → 03 TradeStation returns state and fills → 04 Posición (exits, stop, trailing) → 05 Historial.

Designed screens are reproduced from their PNGs. Undesigned screens use the same shell and components ([design-system.md](design-system.md)). Every screen has explicit loading, empty, error and confirmation states.

## Client

| Route | Screen | Design | Notes |
| --- | --- | --- | --- |
| `/acceso` | Sign in with passkey; link to recovery | `01-access.png` (desktop, mobile) | no password, no sign-up |
| `/activar/[token]` | validate the activation link → register passkey → recovery codes (shown once) | — | one step per view; expired or used links explain how to ask the admin for a new one |
| `/recuperacion` | recovery code (deletes the old passkeys and sessions) → register new passkey → new codes (shown once, with copy) | — (no dedicated design; follows `01-access`) | three steps in one view; a wrong, used or suspended-account code gets one generic error; reloading mid-recovery resumes at the passkey step; the enrollment session lasts 15 minutes |
| `/conexion` | own API key + secret, callback URL to register, connect/reconnect, accounts, mode (SIM; REAL shown disabled), token expiry or «desconocido» | — (no dedicated design; follows the shell of `02-new-order`) | saving a key and disconnecting need a fresh session; the secret is never shown again; `/conexion/callback` checks the single-use `state` and redirects at once to `/conexion` (errors as `?error=<code>`, shown in Spanish); flow in [tradestation-integration.md](tradestation-integration.md#connect-flow-implemented) |
| `/` | redirects (303) to `/operar` | — | the root has no screen of its own |
| `/operar` | Nueva entrada: Acciones / Opciones, instrument, read-only SIZE, ask, quantity, MARKET; summary; `Revisar orden` | `02-new-order.png` | the old quote is cleared on contract change; every disabled state gives its reason (market closed, 3/3, 2/2, quote stale, not verified, qty < 1); built (#24): tabs and the symbol are URL parameters (`tipo`, `cuenta`, `simbolo`; any other parameter is a 400), the engine's `prepareEntry` supplies SIZE, ask and quantity (read-only rows, no price/SIZE/quantity field exists), the limits line comes from the engine's `limits` RPC, and editing the symbol or account drops the preview on screen. `Revisar orden` stays disabled until the review step (#26) exists; «Elegir contrato» points at `/operar/cadena` (#25) |
| `/operar/cadena` | option chain: underlying → expiry → strike × CALL/PUT with bid/ask and freshness | — | opened from «Cambiar contrato»; stream open only while visible |
| `/operar/revisar` | review → send → live intent state (SENT, ACK, PARTIAL, FILLED, REJECTED, UNKNOWN) | — | re-confirm if the server's quantity changed |
| `/posiciones` | switcher (≤2), detail, progress, 7 scale-out steps, protection (stop state, trailing selector + activate), primary `Cerrar posición` (ALL OUT), pending orders with cancel | `03-position.png` | the bar acts only on the selected position |
| `/historial` | orders, states, quantities, fills, cancels, events | — | no P&L |

## Admin

| Route | Screen | Notes |
| --- | --- | --- |
| `/admin` | Clients: list with access and connection status; create client (shows its activation link once, to share personally) | Built (#32). Access: `Invitado` (no passkey yet), `Activo`, `Desactivado` (banned); connection: `Conectada` when a `broker_connection` row exists, else `Sin conectar` (refined with #35). Creating needs an admin with a session under 10 minutes old; a stale one gets 401 `REAUTH_REQUIRED` and the screen offers «Confirmar con passkey». Other errors: 409 `EMAIL_TAKEN`, 400 `INVALID_EMAIL`, 500 `CREATE_FAILED`. The link is in the action response only (`no-store`), never in a load, the audit row or a log. Every `/admin/**` load and action calls `requireAdmin` (403 for a client, 401 without a session). |
| `/admin/clientes/[id]` | Client detail: profile and role; activation link (generate a new one, shown once; revoke); activate/deactivate; sessions (revoke); controlled recovery; settings (SIZE increase-only, stop %, unlock %, each "new entries/positions only"; the 2/3 limits read-only); connection (accounts, status, expiry, last sync; never secrets); open positions and orders | Access parts built (#33); settings built (#34); connection/positions (#35) is a marked empty section. Each client in `/admin` links here. The id comes from the URL and must be a client (unknown id or an admin: 404; malformed: 400). Actions: `?/generateLink` (only for a client with no passkey and not deactivated; a client with a passkey is re-invited through recovery), `?/revokeLink`, `?/deactivate` / `?/reactivate` (ban flag + all sessions + audit in one batch; broker orders are never touched), `?/revokeSession` (the session must belong to this client), `?/revokeAllSessions`, `?/updateSettings` (form fields `sizeUsd` in whole US dollars, `stopPct`, `unlockPct`; see below), `?/recover` (needs the «Verifiqué la identidad del cliente fuera de la app» checkbox; ends sessions, deletes passkeys and recovery codes, closes the open link and issues a new one, in one batch). Every action needs `requireAdmin` and a session under 10 minutes old (stale: 401 `REAUTH_REQUIRED` and «Confirmar con passkey») and writes an audit row (`activation_link.regenerate`/`.revoke`, `client.deactivate`/`.reactivate`, `session.revoke`/`.revoke_all`, `client.recover`; counts only; `client_settings.update` with the before and after values). A new link is in the action response only (`no-store`), never in a load or the audit row. |
| `/admin/administradores/[id]` | Recovery of another admin (D31): admin's passkey and code counts, controlled recovery with the identity confirmation; shown once as a new activation link. Never the signed-in admin's own account. Reached from «Otros administradores» on `/admin` | Built |
| `/admin/operativa` | all clients: open positions, pending orders, protection state, UNKNOWN intents, entries used today | read-only |
| `/admin/historial` | orders, fills, events and errors across clients; filter by client, mode, account, symbol, state, date, type | |
| `/admin/auditoria` | audit log: actor, action, target, before → after, time; access and invitation events | |

### Admin client settings

`?/updateSettings` saves SIZE, stop % and trailing-unlock % of one client (`src/lib/server/admin-client-access.ts`). The three fields travel together; unknown fields are rejected (400).

- SIZE is whole US dollars (the `size_usd` column), increase only: a lower value is rejected (422 `SIZE_DECREASE`). The same value is allowed when a percentage changes; a save that changes nothing is rejected (409 `SETTINGS_UNCHANGED`).
- Stop % and unlock % are whole numbers inside the bounds of `src/lib/domain/config.ts`, checked by `validateStopPct` and `validateTrailingUnlockPct` (422 `STOP_PCT_OUT_OF_BOUNDS`, `TRAILING_UNLOCK_PCT_OUT_OF_BOUNDS`) with Spanish messages that quote the bounds.
- The values apply to new entries and new positions only; every open position keeps the stop % and unlock % stored on it. The screen says so next to each field.
- The UPDATE matches the values the check ran against, so a concurrent change fails (409 `SETTINGS_CHANGED`) rather than slipping under the increase-only rule; it commits in one batch with its audit row.
- The 2 open positions and 3 entries per market day are shown read-only from the domain constants; no action changes them.

## Not carried over from the demos

`TEST STOP`, `REINICIAR SESIÓN/SIM`, `ACTUALIZAR COTIZACIÓN SIMULADA`, editable «Prima de referencia», `NORMAL / −25% / −50%`, «Stops diarios 0/2». See [decisions.md](decisions.md).
