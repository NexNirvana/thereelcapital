# Open questions

Each item is tracked as a GitHub issue. Answered items move to [decisions.md](decisions.md).

## Product (user decides)

None open. Questions 1–5 and 13 were decided on 2026-10-21 (trailing set and bounds, adding to a position, retention and budget, no email, redemption rate limits): see D19–D22, D25 and D28 in [decisions.md](decisions.md).

## TradeStation (SIM spike)

6. ~~Exact error at absolute refresh-token expiry, and whether the 24 h lifetime counts from authorization or from the first rotation.~~ Decided 2026-10-26 (D44): the 24 h applies only to keys that rotate, counted from the first observed rotation. This key does not rotate, so it has no countdown. The exact error at a rotating key's expiry stays unobserved; a refused refresh (403 `invalid_grant`) already marks the connection revoked.
11. ~~Behavior of an option at expiry, and the resulting positions.~~ Decided 2026-10-26 (D45): the engine closes the position at MARKET 15 minutes before the close of its expiration day, so the broker's expiry handling never applies to the app.

Also unobserved: partial fills (`FPR`, `FLP`), which SIM does not produce for 1-share orders, and how a triggered broker-held stop fills.

Answered by the spikes of 2026-10-22 and 2026-10-26 ([tradestation-integration.md](tradestation-integration.md), samples in `engine/test/fixtures/sim/`):

- 6 (partly): the refresh token of the test key is not rotated, the access token lives 1200 s and a refused refresh is 403 `{"error":"invalid_grant",...}` (`refresh/`).
- 7: SIM accounts are the ones the SIM host lists (Margin and Futures, `Active`); whether one token serves SIM and LIVE is not tested, because that needs the live host, which is forbidden (`accounts/`).
- 8: option quotes are served by `GET /marketdata/quotes` (`quotes/quote-option.json`).
- 9: option `PointValue` is 100 and `AssetType` `STOCKOPTION` (`symbols/symbol-option.json`); `TradeAction` `BUYTOOPEN` and `SELLTOCLOSE` in upper case are accepted (`option-order/`).
- 10: `StopMarket` and trailing `StopMarket` (`AdvancedOptions.TrailingStop.Percent`) on options are accepted in the regular session and cancel cleanly (`stops/`). T13 stays engine-held (D36); this only enables a later broker-held improvement.
- 12: 320 requests per 300 s per resource on SIM, reported in `x-ratelimit-*` headers (`rate-limits/`).

Timing values are decided: D33 in [decisions.md](decisions.md).

## Config values to confirm

Questions 14 and 15 (`SYNC_MIN_INTERVAL_MS`, `PROTECTION_SETTINGS_TTL_MS`) were decided on 2026-10-23: see D40 in [decisions.md](decisions.md).

16. `REFRESH_REJECTIONS_BEFORE_REVOKED` (currently 5, `src/lib/domain/config.ts`): how many refused refreshes in a row before a connection is marked revoked; the wait doubles from 1 minute. Provisional since 2026-10-27 (D49); the owner decides, ideally after the `broker.refresh_failed` codes of the shared key are read.
