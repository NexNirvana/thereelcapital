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
- **SIZE −25% for one entry (D51).** The client may choose `down25` for one entry; the SIZE in the formulas above is then `appliedSize(SIZE, choice)` = floor(SIZE × `SIZE_DOWN_APPLIED_PCT` / 100) in micros (15,000 for 20,000), otherwise the SIZE itself. The browser sends the closed choice (`full` | `down25`, or `custom` with an amount, see below); the choice is not stored in D1 and the next entry starts at `full`. Example: SIZE 20,000, ask 4.00 → 37 contracts at −25% (50 at full). The intent stores the choice (`size_choice`) and the SIZE used (`size_applied`) before the broker call.
- **SIZE chosen by the client (D53).** Only while `client_settings.client_sets_size` is on for the client, the browser may send `custom` with `sizeUsd`, whole US dollars; `entrySize` (`src/lib/domain/sizing.ts`) accepts it only from `CUSTOM_SIZE_MIN_USD` (1) up to the configured SIZE, and the applied SIZE is `sizeUsd × MICROS_PER_USD`. Otherwise the entry is blocked with `CUSTOM_SIZE_DISABLED` (switch off) or `CUSTOM_SIZE_OUT_OF_RANGE` (zero, negative, above the SIZE). The engine reads the switch and the SIZE from D1 at prepare and again at send (`prepareEntry` and `sendEntry` always call `loadEntryInputs`; only the live preview of the socket uses the cache `EntryInputsCache`, which the admin's save invalidates), so turning the switch off between the two refuses the send with nothing reserved. `custom` without an amount, or an amount without `custom`, is `INVALID_INPUT`. The intent stores `size_choice = 'custom'` and `size_applied`. Example: SIZE 20,000, ask 101, amount 5,000 → 49 shares.
- **Deploy skew.** The web sends `sizeChoice` only when it is not `full`, and `sizeUsd` only for `custom`; the engine rejects unknown fields and the unknown literal, so an old engine fails the call instead of sending a full-size order; the web also refuses a preview whose echoed choice differs from the one asked for, and for `custom` one whose applied SIZE is not exactly the typed amount (`choiceApplied`).
- At send time the server recomputes the quantity. If it differs from what the client confirmed, return "re-confirm" instead of sending.

## 2. SIZE changes

`newSize > currentSize` or reject. Only an admin can change it; it applies to new entries only.

## 3. Daily entries (the client's limit · mode · market session date)

The limit is a per-client setting the admin edits, a whole number from 1 to 1000 and 3 by default (`client_settings.max_daily_entries`, D48). The engine reads it from D1 together with SIZE for every entry.

- `consumed + reserved < maxDailyEntries` to reserve; check and reserve in one synchronous transaction.
- A BUY intent consumes its reservation on its **first fill** (partial fills and retries of the same intent don't consume again).
- The reservation is released only on REJECTED or CANCELED with zero fills. UNKNOWN keeps it.
- Exits never consume or return entries. The limit never blocks exits or cancels.
- `session_date` comes from the market calendar, not the browser.

## 4. Open positions (2 per client · mode, fixed)

`open + reservedOpens < 2` to reserve a slot. The slot is freed on a zero-fill REJECTED/CANCELED entry or when the broker reports zero remaining or our own exits have sold the whole position (shared accounts, `order-lifecycle.md`), never when ALL OUT is pressed.

## 5. Order guards

Reject unless all hold: mode is SIM; the account belongs to the client and is active Cash/Margin; the instrument is an equity or a single-leg option (no futures, no spreads); `OrderType` is Market; `TradeAction` is BUY/SELL (equity) or BUYTOOPEN/SELLTOCLOSE (option); a sell's qty ≤ `available`; the instrument is inside its regular session; no other open position on the same symbol (additions are not supported, see §9).

## 6. Scale-out steps

Steps `[30, 20, 10, 10, 10, 10, 10]` (sum 100), each with its own index and used once per position. The base is `original_qty`, fixed after the entry's fills are reconciled.

```
cumPct = Σ pct of steps already done or pending + pct of this step
target = roundHalfUp(original_qty × cumPct / 100)     // equities: round to increment
qty    = clamp(target − (sold_qty + committed), 0, available)
```

- `qty = 0` from the step's own rounding: the step becomes `done_zero` (its % still counts in `cumPct`), no order is sent, and the UI says «0 contratos por redondeo». A zero only because open sells already cover the target leaves the step `available` and is refused (`NOTHING_AVAILABLE`).
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
- The engine holds it (D36): the DO checks fresh bids on the sync tick and sends the MARKET sell through the sell ledger; no broker stop order exists. A stop exit never consumes an entry and limits never block it.
- It is a trigger, not a loss guarantee; the UI copy says so.

### Expiration-day close (D45)

- An option still open on its expiration day is sold whole at MARKET, `EXPIRY_CLOSE_LEAD_MS` (15 minutes, `config.ts`) before that day's regular-session close: 15:45 ET on a normal day, 12:45 ET on an early-close day. The close comes from the options calendar (`src/lib/domain/expiry.ts`), never a literal. Why: a long option in the money at expiry is exercised into 100 shares per contract (buying power, a stock position the app never opened); out of the money it vanishes.
- The monitor runs it on the same sync tick and through the same exit path as the stop (intent kind `stop`, event `protection.expiry_triggered`): `available` is sold, limits never block it and no counter moves. Once the intent exists `available` is zero, so ticks, alarms and DO restarts do not fire it again; a REJECTED close waits out `STOP_REJECTED_COOLDOWN_MS`, as a stop does. A timeout is UNKNOWN and is reconciled; nothing is retried.
- Like the stop, it needs a fresh bid: without one (or with quotes unavailable, or an exit of the position UNKNOWN) the position stays `unverified`, nothing is sent, and `protection.expiry_close_skipped` is logged once. With the connection unusable the exit path blocks (`CONNECTION_UNUSABLE`) and the outcome is logged as for a stop.
- Sells already working are not canceled: they count as committed, so only the rest is sold. (verify on SIM: a working exit that fills after the close order was placed)
- From the start of the expiration day (New York) the position shows «Vence hoy · se cierra 15:45 ET». Equities are unaffected. What the broker does at expiry itself (verify on SIM) no longer matters to the app, because the position is closed before.

## 8. Trailing

- Eligible iff `sold_qty / original_qty ≥ trailing_unlock_pct / 100` and `original_qty − sold_qty > 0`, using the `trailing_unlock_pct` stored on the position.
- `trailing_pct` must be one of {1, 5, 8, 10, 15, 20} (default 10). The admin's `stop_pct` must be within 10–50 and `trailing_unlock_pct` within 30–90; all of these live in one config module ([product-spec.md](product-spec.md#parameters)). The bounds are checked when a value is **written** (admin settings, activation). When a rule is **evaluated**, the value stored on the position is trusted even if the bounds changed since; only a value that cannot be a percentage (not a whole number from 1 to 99) is rejected as corrupt.
- Activation is refused while a sell of the position is working or has an unknown outcome, when the position is not yet eligible, when trailing is already active, and when there is no live bid. The percentage cannot be changed afterwards.
- On manual activation: `peak = fresh bid`. On each fresh quote: `peak = max(peak, bid)`, `trailLevel = max(trailLevel, peak × (1 − trailing_pct / 100))`.
- Effective exit level = `max(stopLevel, trailLevel)`. When the bid ≤ effective level, the engine (D36) sells `available` at MARKET through the same exit path as the stop.

## 9. Adding to a position

Not supported in the pilot (D21): the guard in §5 rejects a BUY on an instrument that already has an open position in that mode. After a full close, a new BUY opens a new position and consumes an entry as usual. If additions are ever enabled, each additional intentional BUY consumes one entry on its first fill, and their effect on `original_qty`, the steps, the average price and the protections must be specified first.

## 10. Market calendar

`isRegularSession(instrument, now)` and `sessionDate(now)` in America/New_York. Sessions, holidays and early closes come from the `market-calendar` library (equities: `NYSE`; options: `CBOE_Equity_Options`), never from hand-kept dates. The regular session is 09:30–16:00 ET, or 13:00 on early-close days. This includes ETF options, whose exchange session runs to 16:15: the app stops at 16:00 for every option (D30). `Instrument.kind` is the `equity | option` union, so a kind without an exchange calendar cannot be expressed.

## 11. Trading modes (D52)

`allowedModes({ deploymentOpen, clientEnabled, hasOpenReal })` in `src/lib/domain/modes.ts` returns `{ entries, exits }`, the modes a client may use now. SIM is always in both. `deploymentOpen` is lock 1 (the engine's `REAL_TRADING` is exactly `"enabled"`), `clientEnabled` is lock 2 (`client_settings.real_trading_enabled`, set by an admin), `hasOpenReal` is an open REAL position or unfinished REAL intent. The account lock (3) and the transport lock (4) are checked per order, not here. Turning the client switch off blocks new REAL entries but never exits or protections of what is open.

| deployment | client | open REAL | entries | exits |
| --- | --- | --- | --- | --- |
| closed | any | any | SIM | SIM |
| open | off | no | SIM | SIM |
| open | off | yes | SIM | SIM, REAL |
| open | on | any | SIM, REAL | SIM, REAL |

Which lock each action needs (the engine's RPC surface and `checkOrder` both apply it; a refusal is `MODE_NOT_ENABLED`, «El modo REAL no está habilitado para esta cuenta.»):

| Action | REAL needs |
| --- | --- |
| Entry (`prepareEntry`, `sendEntry`) and the chain reads | deployment and client flag (`entries`) |
| Exit, cancel, trailing activation, `sync`, and the engine's own protection and expiry sells | deployment, and the client flag or an open REAL position or intent (`exits`) |
| Read-only views (`state`, `history`, `positions`, `limits`, `connection`, `overview`) | the deployment only, so an admin can read a client whose flag is off |
| Connection (`beginConnection`, `completeConnection`, `disconnect`) | never: one connection serves both modes |

Every order, whatever its mode, also passes lock 3 (the account is listed by that mode's host and stored for that mode) and lock 4 (the transport checks the request against the mode's base URL).

The limits of §3 and §4 are per mode: SIM and REAL each have their own daily entries count and their own 2 open positions, so a full SIM day never blocks a REAL entry and the reverse. The daily limit value is the client's one setting for both. A REAL entry is sized from the client's SIZE and the ask the REAL broker reports when the order is sent, so it can differ slightly from the preview the terminal showed with SIM data.

The engine reads `allowedModes` through `activeModes` (`engine/src/mode.ts`), which decides the modes its background passes serve, and through `modeAllowedNow` for each RPC. The `modes` RPC returns the same `{ entries, exits }` to the web.
