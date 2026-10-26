# TradeStation fixtures

These files are **derived from the examples in the official TradeStation v3 OpenAPI spec** (linked from `docs/tradestation-integration.md`), not recorded from the SIM API. Where the spec has no example for what the product needs (an option's symbol details, an order response with `Errors`), the shape follows the spec's schema and the values are invented. Account ids and order ids are the spec's placeholders.

Issue #21 (the SIM spike) records real SIM responses in the `sim/` folders below. Only `refresh.test.ts` decodes a `sim/` sample so far; the derived files above remain what the other tests decode.

| File | Source |
| --- | --- |
| `accounts.json` | spec example of `GET /brokerage/accounts` |
| `symbol-details-equity.json` | spec example of `GET /marketdata/symbols/{symbols}` (MSFT) |
| `symbol-details-option.json` | schema-derived: `STOCKOPTION` with `PointValue` 100 (verify on SIM) |
| `quotes.json` | spec example of `GET /marketdata/quotes/{symbols}` |
| `expirations.json` | spec example of `GET /marketdata/options/expirations/{underlying}` |
| `strikes.json` | schema-derived from the spec's `Strikes` example, one strike per spread |
| `orders.json` | spec example of `GET /brokerage/accounts/{accounts}/orders`, extended with schema-derived option, canceled, rejected, multi-leg, short and unmapped-status orders |
| `positions.json` | spec example of `GET /brokerage/accounts/{accounts}/positions`, plus a schema-derived option and a short position |
| `confirm.json`, `place.json`, `place-refused.json`, `cancel.json` | spec examples of `orderconfirm`, `POST orders` (the success example trimmed to one order, and its `Errors` example alone) and `DELETE orders/{id}` |

The `sim/<step>/` folders, written by `bun run spike` (`scripts/sim-spike/`), hold real SIM responses with secrets, tokens and account numbers redacted (credentials and tokens are `[REDACTED]`, account ids keep only their last four characters). Each file is `{ request, response: { status, headers, body } }`; the two chain stream samples (`chain/chain-stream.json`, `quotes/chain-for-pick.json`) have `messages` (the first ones) and `totalMessages` in `response` instead of `body`. The first run (2026-10-22, after the close) recorded accounts, refresh, the equity quote and rate limits; every options step answered 403 "Missing required scope.". The rerun of 2026-10-26 in the regular session replaced those and added the options and order steps:

| Folder | Content |
| --- | --- |
| `auth/` | the authorization code exchange (`scope`, `expires_in`) |
| `refresh/` | `refresh-grant.json` (200, no rotated token) and `refresh-refused.json` (403 `invalid_grant`) |
| `accounts/`, `confirm/accounts.json`, `rate-limits/` | `GET /brokerage/accounts` and its `X-RateLimit-*` headers |
| `quotes/quote-equity.json`, `confirm/quote-equity.json` | equity quote snapshot |
| `symbols/symbol-equity.json` | equity symbol details |
| `expirations/`, `chain/` | expirations, strikes with `spreadType=Single`, and the chain stream (no `EndSnapshot`, 733 messages in 30 s) |
| `quotes/quote-option.json`, `quotes/chain-for-pick.json`, `symbols/symbol-option.json` | option quote, the chain stream used to pick a contract, and option symbol details (`PointValue` 100) |
| `confirm/`, `equity-order/`, `cancel-race/`, `option-order/` | orderconfirm, place, duplicate `OrderConfirmID`, cancel racing a fill, option buy and close, orders and positions listings |
| `stops/` | `StopMarket` and trailing `StopMarket` on an option, their listings and cancels |
| `*positions*.json`, `fill-fields/orders-today.json` | positions and the day's orders (`FLL`, `OUT`, `REJ`) |

The derived files above stay until tests decode the recorded samples instead.
