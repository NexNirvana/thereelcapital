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
