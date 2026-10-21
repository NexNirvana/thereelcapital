# Open questions

Each item is tracked as a GitHub issue. Answered items move to [decisions.md](decisions.md).

## Product (user decides)

1–5. Decided on 2026-10-21: trailing set and bounds, adding to a position, retention and budget; and no email (activation links shared by the admin). See [decisions.md](decisions.md) (D19–D22, D25).

13. Rate limits for redeeming a recovery code and opening an activation link. Provisional in `config.ts`: 5 attempts per 10 minutes per IP each.

## TradeStation (SIM spike)

6. Exact error at absolute refresh-token expiry; whether a key rotates refresh tokens.
7. Whether one token serves SIM and LIVE; how SIM accounts are identified.
8. Option quotes through the snapshot endpoint, or stream only.
9. Option `PointValue` (expected 100) and `TradeAction` casing for options.
10. StopMarket and trailing StopMarket on options in regular session (decides T13).
11. Behavior of an option at expiry, and the resulting positions.
12. Which rate-limit numbers apply (250 vs 320 / 5 min).
