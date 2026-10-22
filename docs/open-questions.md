# Open questions

Each item is tracked as a GitHub issue. Answered items move to [decisions.md](decisions.md).

## Product (user decides)

1–5, 13. Decided on 2026-10-21: trailing set and bounds, adding to a position, retention and budget; no email (activation links shared by the admin); and the recovery and activation redemption rate limits. See [decisions.md](decisions.md) (D19–D22, D25, D28).

## TradeStation (SIM spike)

6. Exact error at absolute refresh-token expiry; whether a key rotates refresh tokens. Also the status and body of a refused refresh, and whether the 24 h lifetime counts from authorization or from the first rotation.
7. Whether one token serves SIM and LIVE; how SIM accounts are identified.
8. Option quotes through the snapshot endpoint, or stream only.
9. Option `PointValue` (expected 100) and `TradeAction` casing for options.
10. StopMarket and trailing StopMarket on options in regular session (decides T13).
11. Behavior of an option at expiry, and the resulting positions.
12. Which rate-limit numbers apply (250 vs 320 / 5 min).

Timing values: decided (D33 in [decisions.md](decisions.md)).
