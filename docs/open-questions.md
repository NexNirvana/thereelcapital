# Open questions

Each item is tracked as a GitHub issue. Answered items move to [decisions.md](decisions.md).

## Product (user decides)

None open. Questions 1–5 and 13 were decided on 2026-10-21 (trailing set and bounds, adding to a position, retention and budget, no email, redemption rate limits): see D19–D22, D25 and D28 in [decisions.md](decisions.md).

## TradeStation (SIM spike)

6. Exact error at absolute refresh-token expiry, and whether the 24 h lifetime counts from authorization or from the first rotation. Partly answered by the spike of 2026-10-22 (see below); the absolute expiry is not observable in one session and stays open.
8. Option quotes through the snapshot endpoint, or stream only.
9. Option `PointValue` (expected 100) and `TradeAction` casing for options.
10. StopMarket and trailing StopMarket on options in regular session. T13 is decided (engine-held, D36); the answer would only enable a later broker-held improvement.
11. Behavior of an option at expiry, and the resulting positions.

Items 8–11 need the rerun in the regular session with the `OptionSpreads` scope; the first run (2026-10-22, after the close) got 403 "Missing required scope." on every options endpoint.

Answered by the spike of 2026-10-22 ([tradestation-integration.md](tradestation-integration.md), samples in `engine/test/fixtures/sim/`):

- 6 (partly): the refresh token of the test key is not rotated, the access token lives 1200 s and a refused refresh is 403 `{"error":"invalid_grant",...}` (`refresh/`).
- 7: SIM accounts are the ones the SIM host lists (Margin and Futures, `Active`); whether one token serves SIM and LIVE is not tested, because that needs the live host, which is forbidden (`accounts/`).
- 12: 320 requests per 300 s per resource on SIM, reported in `x-ratelimit-*` headers (`rate-limits/`).

Timing values are decided: D33 in [decisions.md](decisions.md).

## Config values to confirm

None open. Questions 14 and 15 (`SYNC_MIN_INTERVAL_MS`, `PROTECTION_SETTINGS_TTL_MS`) were decided on 2026-10-23: see D40 in [decisions.md](decisions.md).
