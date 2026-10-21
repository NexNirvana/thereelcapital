# Domain rules

The trading rules, written to be implemented as pure functions in `src/lib/domain/` (no IO, no clock reads, no Effect services; pass `now`, quotes and settings in). The `ClientCoordinator` DO calls them; nothing else re-implements them. Parameter values and who may change them are in [product-spec.md](product-spec.md#parameters). Persistence, atomicity and the sell ledger are in [order-lifecycle.md](order-lifecycle.md).

Vocabulary, per position: `original_qty` (entry quantity confirmed by fills), `sold_qty` (exit quantity confirmed by fills), `committed` (quantity in pending exits), `available = original_qty − sold_qty − committed`. Requested, clicked or pending quantities never count as sold.

## 1. Entry sizing

```
options:  qty = floor(SIZE / (ask × pointValue))           // whole contracts
equities: qty = floorToIncrement(SIZE / ask, increment)    // QuantityFormat.Increment
```

- `ask` is the TradeStation ask for the exact symbol. `pointValue` and `increment` come from TradeStation symbol details, never a constant.
- Block, with a reason, when the quote is missing, stale or halted, the symbol details are missing, or `qty` < `MinimumTradeQuantity`. There is no manual or browser-supplied price.
- SIZE is a target: a MARKET fill can cost more than SIZE. Store on the intent the SIZE, quote and point value that were used.
- Example: SIZE 20,000, ask 4.00, point value 100 → 50 contracts.
- At send time the server recomputes the quantity. If it differs from what the client confirmed, return "re-confirm" instead of sending.

## 2. SIZE changes

`newSize > currentSize` or reject. Only an admin can change it; it applies to new entries only.

## 3. Daily entries (3 per client · mode · market session date)

- `consumed + reserved < 3` to reserve; check and reserve in one synchronous transaction.
- A BUY intent consumes its reservation on its **first fill** (partial fills and retries of the same intent don't consume again).
- The reservation is released only on REJECTED or CANCELED with zero fills. UNKNOWN keeps it.
- Exits never consume or return entries. The limit never blocks exits or cancels.
- `session_date` comes from the market calendar, not the browser.

## 4. Open positions (2 per client · mode)

`open + reservedOpens < 2` to reserve a slot. The slot is freed on a zero-fill REJECTED/CANCELED entry or when the broker reports zero remaining, never when ALL OUT is pressed.

## 5. Order guards

Reject unless all hold: mode is SIM; the account belongs to the client and is active Cash/Margin; the instrument is an equity or a single-leg option (no futures, no spreads); `OrderType` is Market; `TradeAction` is BUY/SELL (equity) or BUYTOOPEN/SELLTOCLOSE (option); a sell's qty ≤ `available`; the instrument is inside its regular session; no other open position on the same symbol (interim rule while additions are undefined, see §9).

## 6. Scale-out steps

Steps `[30, 20, 10, 10, 10, 10, 10]` (sum 100), each with its own index and used once per position. The base is `original_qty`, fixed after the entry's fills are reconciled.

```
cumPct = Σ pct of steps already done or pending + pct of this step
target = roundHalfUp(original_qty × cumPct / 100)     // equities: round to increment
qty    = clamp(target − (sold_qty + committed), 0, available)
```

- `qty = 0`: the step becomes `done_zero` (its % still counts in `cumPct`), no order is sent, and the UI says «0 contratos por redondeo».
- A pending step can't be pressed again. A rejected or zero-fill canceled step returns to `available`.

Expected results, steps pressed in order (encode as unit tests):

| original | qty per step | trailing eligible after step (70% unlock) |
| --- | --- | --- |
| 1 | 0 / 1 / 0 / 0 / 0 / 0 / 0 | never (nothing remains after step 2) |
| 7 | 2 / 2 / 0 / 1 / 1 / 0 / 1 | 4 (5 of 7 = 71%) |
| 37 | 11 / 8 / 3 / 4 / 4 / 3 / 4 | 4 |
| 50 | 15 / 10 / 5 / 5 / 5 / 5 / 5 | 4 (matches the design: 35 sold, 15 left) |
| 80 | 24 / 16 / 8 / 8 / 8 / 8 / 8 | 4 |
| 137 | 41 / 28 / 13 / 14 / 14 / 13 / 14 | 4 |
| 200 | 60 / 40 / 20 / 20 / 20 / 20 / 20 | 4 |

**ALL OUT** sells `available` on the selected position.

## 7. Stop

- `stopLevel = avg_entry_price × (1 − stop_pct / 100)`, using the average fill price (premium for options) and the `stop_pct` stored on the position at open.
- It triggers when a fresh bid ≤ `stopLevel`, and then sells `available` at MARKET.
- It is a trigger, not a loss guarantee; the UI copy says so.

## 8. Trailing

- Eligible iff `sold_qty / original_qty ≥ trailing_unlock_pct / 100` and `original_qty − sold_qty > 0`, using the `trailing_unlock_pct` stored on the position.
- `trailing_pct` must be in the allowed set (a config constant, see [product-spec.md](product-spec.md#parameters)).
- On manual activation: `peak = fresh bid`. On each fresh quote: `peak = max(peak, bid)`, `trailLevel = max(trailLevel, peak × (1 − trailing_pct / 100))`.
- Effective exit level = `max(stopLevel, trailLevel)`. When the bid ≤ effective level, sell `available` at MARKET.

## 9. Adding to a position

Each additional intentional BUY consumes one entry on its first fill (decided). Its effect on `original_qty`, the steps, the average price and the protections is **not decided**, so the guard in §5 rejects it for now.

## 10. Market calendar

`isRegularSession(instrument, now)` and `sessionDate(now)` in America/New_York. Sessions, holidays and early closes come from the `market-calendar` library (equities: `NYSE`; options: `CBOE_Equity_Options`), never from hand-kept dates. The regular session is 09:30–16:00 ET, or 13:00 on early-close days. An instrument kind without an exchange calendar mapping is rejected with a clear reason.
