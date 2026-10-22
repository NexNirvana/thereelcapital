# TradeStation fixtures

These files are **derived from the examples in the official TradeStation v3 OpenAPI spec** (linked from `docs/tradestation-integration.md`), not recorded from the SIM API. Where the spec has no example for what the product needs (an option's symbol details, a chain stream with `EndSnapshot`, an order response with `Errors`), the shape follows the spec's schema and the values are invented. Account ids and order ids are the spec's placeholders.

Issue #21 (the SIM spike) records real SIM responses; those replace these files, and the tests that decode them become the evidence that the schemas match TradeStation.

| File | Source |
| --- | --- |
| `accounts.json` | spec example of `GET /brokerage/accounts` |
| `symbol-details-equity.json` | spec example of `GET /marketdata/symbols/{symbols}` (MSFT) |
| `symbol-details-option.json` | schema-derived: `STOCKOPTION` with `PointValue` 100 (verify on SIM) |
| `quotes.json` | spec example of `GET /marketdata/quotes/{symbols}` |
| `expirations.json` | spec example of `GET /marketdata/options/expirations/{underlying}` |
| `strikes.json` | schema-derived from the spec's `Strikes` example, one strike per spread |
| `chain-stream.ndjson` | spec example of a chain message, plus a schema-derived second row, a heartbeat and `EndSnapshot` |
| `orders.json` | spec example of `GET /brokerage/accounts/{accounts}/orders`, extended with schema-derived option, canceled, rejected, multi-leg, short and unmapped-status orders |
| `positions.json` | spec example of `GET /brokerage/accounts/{accounts}/positions`, plus a schema-derived option and a short position |
| `confirm.json`, `place.json`, `place-refused.json`, `cancel.json` | spec examples of `orderconfirm`, `POST orders` (the success example trimmed to one order, and its `Errors` example alone) and `DELETE orders/{id}` |

The `sim/<step>/` folders, written by `bun run spike` (`scripts/sim-spike/`), hold real SIM responses with secrets, tokens and account numbers redacted (credentials and tokens are `[REDACTED]`, account ids keep only their last four characters). Each file is `{ request, response: { status, headers, body } }`. The first run, on 2026-10-22 after the close, recorded:

| Folder | Content |
| --- | --- |
| `auth/` | the authorization code exchange (`scope`, `expires_in`) |
| `refresh/` | `refresh-grant.json` (200, no rotated token) and `refresh-refused.json` (403 `invalid_grant`) |
| `accounts/`, `confirm/accounts.json`, `rate-limits/` | `GET /brokerage/accounts` and its `X-RateLimit-*` headers |
| `quotes/quote-equity.json`, `confirm/quote-equity.json` | equity quote snapshot |
| `symbols/symbol-equity.json` | equity symbol details |
| `expirations/`, `chain/`, `option-order/`, `stops/`, `quotes/`, `symbols/` `expirations.json` | 403 "Missing required scope." (fixed by requesting `OptionSpreads`) |
| `*positions*.json`, `fill-fields/orders-today.json` | empty positions and orders: the market was closed |

The derived files above are replaced as the rerun records what they stand for.
