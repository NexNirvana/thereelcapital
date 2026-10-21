# Open questions

Each item is tracked as a GitHub issue. Answered items move to [decisions.md](decisions.md).

## Product (user decides)

1. Trailing % allowed set: proposed {1, 5, 8, 10, 15, 20}.
2. Min/max for the admin's stop % and trailing-unlock %.
3. Adding to an open position: its effect on the original quantity, scale-out steps, average price and protections. Rejected until decided.
4. Retention period for history and audit, and the operating budget.
5. Email delivery provider (Resend, Postmark, Amazon SES or Cloudflare Email Service).

## TradeStation (SIM spike)

6. Exact error at absolute refresh-token expiry; whether a key rotates refresh tokens.
7. Whether one token serves SIM and LIVE; how SIM accounts are identified.
8. Option quotes through the snapshot endpoint, or stream only.
9. Option `PointValue` (expected 100) and `TradeAction` casing for options.
10. StopMarket and trailing StopMarket on options in regular session (decides T13).
11. Behavior of an option at expiry, and the resulting positions.
12. Which rate-limit numbers apply (250 vs 320 / 5 min).
