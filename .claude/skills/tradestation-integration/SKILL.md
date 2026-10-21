---
name: tradestation-integration
description: Use when working on REEL CAPITAL's TradeStation broker adapter in the engine Worker — per-client OAuth (v3 auth endpoints), token refresh/rotation, accounts, symbol details, quotes, option chain, order preview/place/cancel, order and position sync, SIM vs LIVE base URLs, rate limits.
---

# TradeStation integration

Spec: `docs/tradestation-integration.md`. It has the endpoint table, order body, status mapping and the facts marked **(verify)**. When you need a field that isn't there, read the official OpenAPI spec at https://api.tradestation.com/docs/specification/ rather than guessing, and add what you learn to the doc.

## Rules

- Only the client's `ClientCoordinator` DO calls TradeStation. Tokens never reach the web Worker or the browser.
- Each client uses **their own** `client_id` and secret (encrypted in `broker_connection`). Auth goes only through `signin.tradestation.com` v3 endpoints, with `audience=https://api.tradestation.com` and `offline_access` in the scopes.
- The access token lives in memory and is refreshed before its 20 minutes run out. If a refresh returns a new refresh token, persist it atomically: rotation is on, and the 24h absolute lifetime applies.
- Base URL from the intent's mode: SIM `sim-api.tradestation.com/v3`. LIVE is rejected before any call.
- Every order: `OrderType: "Market"`, `TimeInForce.Duration: "DAY"`, `OrderConfirmID` = intent id. Never retry a place or cancel.
- Decode every response with Effect `Schema`. Map errors to typed failures (`AuthExpired`, `RateLimited`, `Rejected`, `Timeout`, `Unknown`); read the `X-RateLimit-*` headers.
- Never use the P&L fields of positions or balances.
- The `BrokerAdapter` interface has two implementations: `tradestation/` and `local-sim/` (with fault injection for tests).
