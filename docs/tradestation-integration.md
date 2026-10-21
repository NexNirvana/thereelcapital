# TradeStation integration

Facts come from the TradeStation v3 docs and OpenAPI spec (https://api.tradestation.com/docs/specification/), checked on 2026-10-20. Items marked **(verify)** are not confirmed by the docs and are covered by the SIM spike. The approval notice is in [`references/TRADESTATION_API_APPROVAL.md`](../references/TRADESTATION_API_APPROVAL.md).

All TradeStation calls are made by the client's `ClientCoordinator` DO ([architecture.md](architecture.md)). Nothing else holds tokens.

## Credentials and OAuth

- Each client brings **their own** API key (`client_id`) and secret. They are stored encrypted in `broker_connection`. The key is an Auth0 key: authorize and get tokens only through the v3 auth endpoints.
- Flow: Authorization Code with the client secret (PKCE is a separate key mode for SPAs/native apps; we don't need it).
  - Authorize: `https://signin.tradestation.com/authorize?response_type=code&client_id=…&audience=https://api.tradestation.com&redirect_uri=…&scope=openid offline_access MarketData ReadAccount Trade&state=…`
  - Token: `POST https://signin.tradestation.com/oauth/token` (code exchange and `refresh_token` grant).
  - Revoke: `POST https://signin.tradestation.com/oauth/revoke`. It revokes **all** refresh tokens of that API key.
- Callback URLs must be registered on each client's key and use `https://` (localhost ports 80/3000/3001/8080/31022 are allowed by default). Production callback: `https://thereelcapital.com/conexion/callback`. The onboarding screen must tell the client which URL to register.
- `state` binds the callback to the logged-in REEL CAPITAL session. The callback only links the authorization to that existing profile.

## Token lifetime

- Access token: 20 min (`expires_in: 1200`). The DO refreshes it before expiry and keeps it in memory only.
- Refresh token: by default **non-expiring and non-rotating**. If rotation is enabled on the key, each refresh returns a new refresh token, and rotating tokens have a **24-hour absolute lifetime**, which matches the approval notice for professional data subscribers. Persist the new refresh token atomically on every refresh.
- Detect the policy by watching whether refresh responses carry a new refresh token. Until a rotation is observed, show expiry as "desconocido". The exact error returned at absolute expiry is **(verify)**.
- If expiry is known, warn ahead of time and show «Reconectar con TradeStation». On refresh failure or revocation: block new entries, mark protection unverified, and require reconnect followed by reconciliation ([order-lifecycle.md](order-lifecycle.md)).

## Environments

| Mode | Base URL |
| --- | --- |
| SIM | `https://sim-api.tradestation.com/v3` |
| LIVE (disabled) | `https://api.tradestation.com/v3` |

The DO picks the base URL from the intent's mode. Whether one token serves both and how SIM accounts are identified is **(verify)**. SIM fills are instantaneous with fake money, so SIM proves integration, not execution quality.

## Endpoints used

| Need | Endpoint | Notes |
| --- | --- | --- |
| Accounts | `GET /brokerage/accounts` | `AccountID`, `AccountType` (Cash, Margin, Futures, DVP), `Status`, `AccountDetail.OptionApprovalLevel`. Offer only active Cash/Margin accounts. |
| Symbol details | `GET /marketdata/symbols/{symbols}` | `PriceFormat.PointValue` (multiplier; options = 100 is **(verify)**), `QuantityFormat.Increment`, `MinimumTradeQuantity` |
| Quotes | `GET /marketdata/quotes/{symbols}` (≤100 symbols) | `Bid`, `Ask`, `Last`, `TradeTime`, `MarketFlags.IsDelayed/IsHalted`. There is no bid/ask timestamp, so freshness = our receive time plus `IsDelayed`. Option symbols via the snapshot endpoint are **(verify)**; otherwise `/marketdata/stream/options/quotes`. |
| Expirations / strikes | `GET /marketdata/options/expirations/{underlying}`, `GET /marketdata/options/strikes/{underlying}` | |
| Chain with bid/ask | `GET /marketdata/stream/options/chains/{underlying}` | stream only; at most 10 concurrent per key. Open it while the chain screen is open, close it after. |
| Preview | `POST /orderexecution/orderconfirm` | estimated cost; returns an `OrderConfirmID` |
| Place | `POST /orderexecution/orders` | see body below |
| Cancel | `DELETE /orderexecution/orders/{orderID}` | "cancel request sent" is not a confirmation |
| Orders today/open | `GET /brokerage/accounts/{ids}/orders` | `Status`, `FilledPrice` (avg), legs `ExecQuantity`, `ExecutionPrice`, `QuantityRemaining` |
| History | `GET /brokerage/accounts/{ids}/historicalorders?since=` | excludes open orders, paginated |
| Positions | `GET /brokerage/accounts/{ids}/positions` | `Quantity`, `AveragePrice`, `LongShort`, `AssetType` (ignore its P&L fields) |

Order body (equity; options use the option symbol and `BUYTOOPEN`/`SELLTOCLOSE`, and the spec's leg examples show `BuyToOpen`, so the casing is **(verify)**):

```json
{ "AccountID": "…", "Symbol": "MSFT", "Quantity": "10", "OrderType": "Market",
  "TradeAction": "BUY", "TimeInForce": { "Duration": "DAY" }, "Route": "Intelligent",
  "OrderConfirmID": "<intent id>" }
```

**Idempotency:** `OrderConfirmID` "prevents duplicates; must be unique per API key, per order, per user". Set it to the intent id, so a resent request for the same intent cannot create a second order. There is no other client tag; correlate by the returned `OrderID`.

**Status mapping** to [intent states](order-lifecycle.md): `ACK`, `OPN`, `DON` → ACKNOWLEDGED; `FPR` → PARTIAL; `FLL`, `FLP` → FILLED; `CAN`, `EXP`, `UCH`, `TSC`, `OUT` → CANCELED; `REJ` → REJECTED. Anything else → keep the current state and log it.

## Native protection (decision pending the spike)

v3 supports `StopMarket`, and a percent/amount trailing stop via `AdvancedOptions.TrailingStop` on a `StopMarket` order. The spec examples are equities; support for **options** in regular-session DAY/GTC is **(verify)**. GTC orders live at most 90 days.

Two designs; the spike decides:
1. **Broker-hosted**: a working StopMarket (later a trailing StopMarket) for the remaining qty. It survives our outages, but every scale-out must first cancel/replace it so the sum of working sells never exceeds the position.
2. **Server-monitored**: the DO alarm compares fresh quotes with the levels and sends a MARKET close. Simpler order book, but protection depends on our uptime and token.

Until decided, the DO exposes one `protection_state` (`verified` / `unverified` / `none`) that the UI shows either way.

## Limits and streams

- Rate limits are per key, and each client has their own key. Quotes: 500 requests / 5 min. Accounts/orders/positions: 250–320 / 5 min (the docs disagree, so read the `X-RateLimit-*` headers). Options endpoints: 90 / min. HTTP 429 when exceeded.
- Streams (if adopted): chunked JSON where chunk boundaries are not message boundaries; `Heartbeat` every 5 s idle; `StreamStatus: EndSnapshot | GoAway`; `Error: DualLogon` means close, wait and reconnect.

## Spike checklist (SIM, regular session)

OAuth with a client key and our callback; token refresh and rotation detection; accounts and SIM identification; equity and option quote snapshots; option `PointValue`; chain stream; `orderconfirm` + place with `OrderConfirmID`, including a duplicate resend; cancel racing a fill; status and leg fields during partial fills; positions after close; StopMarket and trailing StopMarket on an option; behavior of an option at expiry.
