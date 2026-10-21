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

### Connect flow (implemented)

1. `/conexion` (fresh session) posts `client_id` and secret. The web Worker passes them straight to the client's DO (`beginConnection`) and never stores or echoes them. The DO encrypts the secret (AES-GCM, `CREDENTIALS_KEY`, [auth-and-security.md#secrets](auth-and-security.md#secrets)), keeps it in `oauth_attempts` with a random 256-bit `state` (hex), single use, expiring after 10 minutes, and returns the authorize URL. A new attempt replaces the previous one.
2. TradeStation redirects the browser to `/conexion/callback?code=…&state=…`. The state is only valid in the DO of the session user, so a foreign, missing, expired or reused state is rejected (`STATE_INVALID`) before anything is sent to TradeStation. The state is consumed before the token request, so a replay finds nothing even if the exchange fails.
3. The DO exchanges the code at `/oauth/token` (form-encoded `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `redirect_uri`), lists the accounts with the access token against the SIM base, and only then writes `broker_connection` (D1: encrypted secret, encrypted refresh token, `key_id`, `status = CONNECTED`, `refresh_expires_at = NULL` for unknown). The access token is kept in the DO's memory only and renewed by the refresher ([Token lifetime](#token-lifetime)). If the account listing fails, the grant is revoked and nothing new is stored; revoking kills every grant of that API key, so a stored connection with the same `client_id` is deleted (with its cached accounts) and one with another key is kept. When the key differs from the stored one, the previous key's grant is revoked (best effort) before the row is replaced.
4. Accounts shown: `AccountType` Cash or Margin with `Status` Active (matched case-insensitively), cached in the DO (`broker_accounts`) as of connect time.
5. Disconnect (fresh session) calls `/oauth/revoke`, then deletes the stored credentials whether or not the revoke succeeded, and tells the client if it did not. Revoking removes **every** refresh token of that API key.

Failures carry stable codes (`STATE_INVALID`, `TOKEN_EXCHANGE_FAILED`, `BROKER_UNAVAILABLE`, `INVALID_BROKER_RESPONSE`) mapped to Spanish copy; response bodies from the auth endpoints are never logged because they can echo submitted values. Nothing here is retried.

**Unverified with a real key** (to be exercised in the SIM spike, #21): the flow has been tested only against a mocked TradeStation. Still **(verify)**: the exact `Status` strings of `GET /brokerage/accounts` (the docs we could read do not list them), the revoke body field (`token` in the official example, `refresh_token` in its parameter table, so both are sent), the error body of `/oauth/token`, and whether a SIM-enabled key lists only SIM accounts on the SIM base.

## Token lifetime

- Access token: 20 min (`expires_in: 1200`). It lives in the DO's memory only. `TokenRefresher` (`engine/src/refresh.ts`) renews it when less than 5 minutes remain, from a DO alarm armed after connecting and after every refresh, and on demand when a caller asks for a token. One refresher per client; concurrent callers share the request in flight (single flight).
- Refresh grant: `POST /oauth/token`, form-encoded `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`.
- Refresh token: by default **non-expiring and non-rotating**. If the key is configured for rotation, each refresh returns a new refresh token, and rotating tokens have a **24-hour absolute lifetime** (the official page also says they expire and rotate every 30 minutes), which matches the approval notice for professional data subscribers.
- Rotation is detected by a new `refresh_token` in the response. The new token, the status and `refresh_expires_at` (now + 24 h the first time rotation is seen, then unchanged: the lifetime is absolute) are written in one D1 `UPDATE` guarded by the old ciphertext, so a reconnect during the request wins. If that write fails, the new token (the only valid one) is kept in memory and written on the next refresh, whatever that response says. A response without a new token leaves the stored one untouched. Until rotation is seen, expiry is shown as "desconocido".
- Only the refresh grant is retried (`Effect.retry`, 2 retries) and only when TradeStation is unreachable or answers 5xx/429. Any other 4xx is terminal.
- Status, as `ConnectionHealth` in `src/lib/domain/connection.ts`: `ok`, `expiring` (known expiry within 2 h), `expired` (the known absolute expiry passed; no refresh is tried), `revoked` (refresh refused), `error` (unreachable or undecodable; retried by the alarm every minute). The `connection` RPC returns it with `entriesBlocked`. `expired` and `revoked` are final until the client reconnects; no further refresh is tried.
- A refresh that finishes after the client reconnected or disconnected is dropped. A key that cannot decrypt the credentials counts as a failed refresh. On any failed refresh: entries are blocked, every open position's `protection_state` becomes `unverified`, a `broker.refresh_failed` event is written, and `reconciliation_pending` is set. Reconnecting restores the connection but **not** the entries: only `markReconciled` (called by the sync loop, M4, after it re-reads orders and positions on a usable connection) lifts the block. Exits and cancels are never blocked by this ([order-lifecycle.md](order-lifecycle.md)). The UI shows the state in the top bar with «Reconectar con TradeStation».
- **(verify)** in the SIM spike (#21): the error body and HTTP status of a refused refresh (the official page documents none, so any 4xx other than 429 is taken as refused), whether the 24 h lifetime is counted from the authorization or from the first rotation, and whether a SIM key is configured for rotation at all.

## Environments

**SIM only. No real money, ever.** The only base URL in code is `https://sim-api.tradestation.com/v3`. LIVE is not a configured environment: there is no live URL constant, setting or code path, and the pre-commit hook rejects the live host outside `docs/`. Adding LIVE would require an explicit decision by the owner and is out of scope.

The DO rejects any mode other than SIM before making a call. Whether one token serves both and how SIM accounts are identified is **(verify)**. SIM fills are instantaneous with fake money, so SIM proves integration, not execution quality.

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

## Adapter (`engine/src/tradestation/`)

The TradeStation implementation of the `BrokerAdapter` interface ([architecture.md](architecture.md)). Its HTTP layer is `http.ts`:

- **SIM guard.** `makeTransport` refuses any mode but `SIM` (`MODE_NOT_SIM`) and any base URL that is not exactly the SIM base (`BASE_URL_NOT_SIM`), so a LIVE configuration fails at construction, before a token is requested. Every request is re-checked against the SIM base right before `fetch`.
- **Errors.** 401 → `AuthExpired`; 429 → `RateLimited` (`retryAfterMs` from `X-RateLimit-Reset`, which the docs define as seconds until the limit resets; there is no `Retry-After`); other 4xx → `Rejected` (`code` = the body's `Error`, else `HTTP_<status>`); 5xx or a dropped connection → `Unknown`; an aborted or timed-out request → `Timeout`. The latest `X-RateLimit-*` headers are kept (`rateLimit()`), also from successful responses.
- **Retries.** Only `get` (reads) retries, twice, after a `Timeout`, a 5xx or a dropped connection. `send` (orderconfirm, place, cancel) makes exactly one attempt: a `Timeout` or `Unknown` there means the order may exist, and the caller marks the intent UNKNOWN ([order-lifecycle.md](order-lifecycle.md), rule 2).
- Tokens come from `TokenRefresher.accessToken()`; a connection without a usable token fails with `AuthExpired` without sending anything.

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
