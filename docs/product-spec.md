# Product spec

What the product does, restated from [`ONBOARDING.md`](../ONBOARDING.md), which wins on any conflict. The rules behind each behavior are in [domain-rules.md](domain-rules.md).

## Purpose

Invited clients trade **US equities and long single-leg options** in **their own TradeStation accounts**, using **their own TradeStation API key**, through a simple terminal instead of the broker's. The client picks a ticker, or a contract from the option chain. The app reads the ask from TradeStation and computes the quantity from the client's SIZE, and the client confirms a **MARKET** order. The client then manages the position with fixed partial exits, ALL OUT, an initial stop and an optional trailing stop.

It is not a signal service, copy trading or a charting tool. There is no AI in the order path. The terminal shows no charts and no P&L.

**First-delivery success criterion:** an authorized order is sent and its real broker state is visible. Accepted is not filled.

## Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Admin | everything in the admin panel ([screens-and-flows.md](screens-and-flows.md#admin)): profiles, invitations, activation/deactivation, roles, session revocation, controlled recovery, SIZE increases, stop % and trailing-unlock % per client, connection status, operational overview, searchable history and errors, audit | lower SIZE; change the 2/3 limits; enable REAL; place or cancel client orders; impersonate clients; skip MFA |
| Client | activate by invitation; register a passkey; connect their own TradeStation key; trade; choose the trailing %; see their history | change SIZE, quantity, stop % or unlock %; sign up without an invitation; skip MFA |

## Parameters

| Parameter | Value | Set by | Applies to |
| --- | --- | --- | --- |
| SIZE per entry | US$20,000 initial | admin, increase only, per client | new entries |
| Open positions | max 2 per client · mode, across accounts | fixed | — |
| New entries | max 3 per client · mode · market day, across accounts | fixed | — |
| Initial stop | 30% below the average fill price | admin, per client, within bounds | new positions |
| Trailing unlock | 70% of the original quantity sold (confirmed) | admin, per client, within bounds | new positions |
| Trailing % | 10% default; allowed set *proposed* {1, 5, 8, 10, 15, 20} | client, at activation | selected position |
| Scale-out steps | 30, 20, 10, 10, 10, 10, 10 (% of the original quantity) | fixed | per position |
| Stop / unlock bounds | *undecided*; server-enforced config constants | — | — |

## In scope

- Equities and single-leg long options chosen from the chain; BUY/SELL and BUYTOOPEN/SELLTOCLOSE; MARKET; regular session only.
- Positions held across sessions with no automatic liquidation. A new day renews the entry quota and nothing else.
- Cancel pending orders. History of orders, fills and events.
- SIM mode. REAL is a later stage and is rejected by the server until then.
- Full admin panel in the pilot.

## Out of scope

Futures, shorting, SELL TO OPEN, BUY TO CLOSE, spreads; any client-chosen order type other than MARKET; charts and P&L in the terminal; public sign-up; a shared REEL CAPITAL API key; SIZE DOWN (−25%/−50%); editable premium; a "reset session" button; adding to an open position (until its effects are decided); REAL.

## Journey

1. **Access**: invitation → email code → passkey → recovery codes → own TradeStation key → OAuth → choose an account.
2. **Prepare**: Acciones (ticker) or Opciones (underlying → expiry → strike × CALL/PUT). Read-only ask with freshness, SIZE and computed quantity.
3. **Review and send**: account, mode, instrument, action, SIZE, quantity, MARKET. The server re-checks everything. If the quantity changed, the client re-confirms; the server never silently sends a different quantity.
4. **Manage**: up to 2 positions; the scale-out bar, ALL OUT and trailing act on the selected one; pending orders show their state and can be cancelled; state is recovered on re-entry.
5. **History**: orders, states, quantities, fills, cancels. No P&L.

## Modes

SIM is the default and only enabled mode. Mode, account and connection are always visible. Switching mode discards an unsent form and shows that mode's data; it sends and cancels nothing. A development fake broker is labelled «simulación local» and is never confused with TradeStation SIM.

## Data retention

Orders, fills, operational events and admin audit persist across sessions. The retention period is undecided; until it is set, nothing is deleted automatically.
