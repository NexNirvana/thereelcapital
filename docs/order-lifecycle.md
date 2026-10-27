# Order lifecycle

How the `ClientCoordinator` DO turns a user action into a broker order and keeps its state truthful. The formulas are in [domain-rules.md](domain-rules.md). The TradeStation fields are in [tradestation-integration.md](tradestation-integration.md).

## Intents

Every action that can reach the broker (entry, scale-out, ALL OUT, stop exit, trailing exit, cancel) is first persisted as an **intent** with its own id. The id doubles as the TradeStation `OrderConfirmID`.

```
ARMED ─► SENT ─► ACKNOWLEDGED ─► PARTIAL ─► FILLED
           │           ├────────► CANCEL_PENDING ─► CANCELED
           │           └────────► REJECTED
           └─► UNKNOWN   (no or ambiguous response: reconcile before anything else)
```

- **ARMED**: the server validated session, role, mode, account, market hours, limits, a fresh quote and the quantity. Entry and slot reservations are taken here.
- **SENT**: request dispatched.
- **ACKNOWLEDGED**: the broker returned an `OrderID`. **Not a fill.**
- **PARTIAL / FILLED**: from the broker's leg `ExecQuantity` and `FilledPrice`. Quantities and prices come only from there.
- **CANCEL_PENDING → CANCELED**: only a broker status makes it CANCELED; a MARKET order may fill first.
- **REJECTED**: reservations are released only if `filled_qty = 0`.
- **UNKNOWN**: timeout, dropped connection or restart between send and acknowledgement. Hold all reservations and block conflicting actions until reconciliation resolves it.

Preparing the form (choosing an instrument, seeing the computed quantity) creates no intent. The UI shows each state distinctly and never says "executed" without a fill.

## Rules

1. **Persist the intent before calling the broker.** A retried request for the same intent reuses the same id and `OrderConfirmID`, so it cannot create a second order. A new user action gets a new id.
2. **Never blind-retry** placing or cancelling. Effect `retry` is allowed only on reads and token refresh. A timeout on place makes the intent UNKNOWN.
3. **No `await` between reading and writing shared state.** The DO interleaves requests at every `await`. Reserve inside `ctx.storage.transactionSync(...)`, then await the broker, then apply the result in another synchronous transaction.
4. **One sell ledger per position**, used by scale-outs, ALL OUT, stop and trailing:
   ```
   committed  = Σ qty of exit intents in ARMED | SENT | ACKNOWLEDGED | PARTIAL(unfilled part) | CANCEL_PENDING(unfilled part) | UNKNOWN
   available  = (original_qty − sold_qty) − committed
   ```
   An exit never asks for more than `available`. If protection fires while an exit is pending, it sells only `available`.
5. A position is CLOSED and frees its slot when the broker reports zero remaining, or when its own recorded exits sold all of it (shared accounts, below).

## Entries

`prepareEntry` and `sendEntry` (`engine/src/entries.ts`) implement the entry path. The browser names the account and instrument only: SIZE is read from `client_settings`, the quantity is [domain-rules.md §1](domain-rules.md#1-entry-sizing) over the broker's fresh ask and symbol details, and a `confirmedQty` from the client is compared with the server's and never used.

1. `prepareEntry`: connection and reconciliation status, then SIZE and the daily entries limit (D1; the limit is read with SIZE and used by the reservation, D48), symbol details and a fresh quote read together (symbol details are cached in the Durable Object's memory for the New York session day, `engine/src/symbol-details.ts`; a rejection or an outage is never cached), checked in that order, `computeEntryQty`, `checkOrder`, then the daily and slot limits as information. No intent, no reservation. It returns a new `intentId` (16 random bytes, base64url, 22 characters, the `OrderConfirmID` limit).
2. `sendEntry`: the same checks again. A different quantity returns `RECONFIRM` and reserves nothing. Otherwise **one synchronous transaction** re-checks reconciliation, the guards and both limits, increments `entry_counters.reserved` and inserts the intent as ARMED with `size_applied`, `size_choice` (D51), `quote_json` and `point_value`. The slot is derived from the intent (architecture.md#data-model), so it needs no counter.
3. The intent is set to SENT, then `placeOrder` is called once. A repeat of the same `intentId` (even concurrent) finds the intent and returns its state without calling the broker; the same id for another account or symbol is `INVALID_INPUT`.
4. Outcome: an `OrderID` makes it ACKNOWLEDGED. `Rejected`, `AuthExpired` and `RateLimited` mean the broker did not take the order: REJECTED, and the daily reservation is released in the same transaction as the state change (the slot frees with the state). `Timeout`, `Unknown` or any unexpected failure make it UNKNOWN with both reservations held until reconciliation (#23).

Entries are refused (nothing written) while the connection is unusable, a reconciliation is pending, outside the regular session, or when a limit is reached. Limits never apply to exits or cancels.

## Exits and cancels

`exitPosition` and `cancelIntent` (`engine/src/exits.ts`) implement them; the sell ledger and the steps are in `engine/src/ledger.ts`. The browser names a position and a step (0 to 6) or ALL OUT, or an intent to cancel; the quantity is never sent.

1. `exitPosition`: connection and symbol details are read first (nothing written). Exits do not wait for a reconciliation and are never limited (limits are for entries); they need a usable connection and the regular session.
2. **One synchronous transaction**: the position is re-read, an `UNKNOWN` exit on it blocks everything (`UNKNOWN_INTENT_PENDING`), the quantity is `scaleOutQty` (step) or `allOutQty` over `available = original − sold − committed`, `checkOrder` runs with that `available`, and the intent is inserted ARMED (`kind = exit`, `SELL` or `SELLTOCLOSE`) with the step set to `pending`. `committed` here is the unfilled part of every non-entry intent that is ARMED, SENT, ACKNOWLEDGED, PARTIAL, CANCEL_PENDING or UNKNOWN (a pending cancel can still fill).
3. A step that rounds to zero on its own becomes `done_zero`: no intent exists and nothing is sent. A zero caused by open sells already covering the step's target returns `NOTHING_AVAILABLE` and leaves the step `available`, since those sells may still be rejected or canceled.
4. SENT, then `placeOrder` once. Outcome as for entries: ACKNOWLEDGED, REJECTED (the step is given back in the same transaction) or UNKNOWN (the step stays `pending`, the quantity stays committed, reconciliation resolves it).
5. Reconciliation moves the step with its intent: any fill makes it `done` (even if the order was then canceled, since later steps already count its percentage; ALL OUT sells the rest); REJECTED or CANCELED with no fill makes it `available` again.
6. `cancelIntent`: in the regular session only, and not while another order of the position is UNKNOWN; only an app intent that is ACKNOWLEDGED or PARTIAL with a broker order id. It moves to CANCEL_PENDING first, then `cancelOrder` is called once. Success means "request sent": only the broker's order status ends CANCEL_PENDING (CANCELED, or FILLED if the order won the race). `AuthExpired` and `RateLimited` mean the broker did not take the request, so the previous state is restored; a timeout or refusal leaves CANCEL_PENDING for reconciliation. A repeated cancel returns the state without calling the broker.
7. After either call the sync loop is scheduled, so fills are applied while anything is pending.

## Expiration-day close

An option still open on its expiration day is closed by the stop monitor 15 minutes before that day's close ([domain-rules.md §7](domain-rules.md#expiration-day-close-d45), D45). It is a `stop`-kind exit: intent persisted before the call, one attempt, UNKNOWN reconciled, never blocked by limits.

## Reconciliation

When: a client opens the app, reconnects TradeStation, the DO starts, any intent is UNKNOWN, and on every sync-loop tick while something is open.

How: read the broker's orders and positions for the client's accounts in that mode → match orders to intents by `OrderID` / `OrderConfirmID` → apply status and fills → adopt positions and orders made outside REEL CAPITAL (another terminal, or existing activity at first connect) as external, so they count against `available` → recompute ledgers, counters and slots → only then accept new entries and resolve UNKNOWN intents.

Entries stay blocked and open positions show `unverified` protection from a failed refresh, a connect or a disconnect until a reconciliation completes; only `markReconciled` lifts the block, and a hold that lands while it waits is not lifted by it.

A `sync` request (a page load or poll) does not read the broker again when the last good pass is younger than `SYNC_MIN_INTERVAL_MS` and no reconciliation is pending; it returns the current state. The loop's own tick is never throttled. The protection settings the pass needs are read from D1 and reused for `PROTECTION_SETTINGS_TTL_MS`; D1 stays their only owner, so an admin change reaches the engine within that time.

Reconnecting never resets counters, reservations or scale-out steps.

Each good pass also prunes `events` older than the 6-year retention of D22 (`EVENT_RETENTION_MS`); nothing else is ever deleted.

**Applying broker state** (`engine/src/reconcile.ts`). The sync loop reads orders and positions first, then `reconcile` applies them in ONE synchronous transaction, so counters, the sell ledger and positions never see a half-applied pass. It only records what the broker says; it never places or retries an order.

- An intent's status and `filled_qty` come from its broker order. `filled_qty` never decreases, and an intent never moves backwards (a PARTIAL stays PARTIAL on a stale `ACKNOWLEDGED`, a CANCEL_PENDING stays pending while the order is open). An unmapped broker status keeps the current state and is logged.
- **First fill** of one of our entries: `consumed + 1`, `reserved − 1`, on the market day the reservation was taken. **Terminal with zero fills** (REJECTED or CANCELED): `reserved − 1`, and the slot frees because it is derived from the state.
- **Terminal entry with fills** (FILLED, or CANCELED/REJECTED after a partial fill): the position is created in the same transaction with `original_qty` = the filled quantity, `avg_entry_price` from the broker's average fill, the client's `stop_pct` and `trailing_unlock_pct`, protection `none`, and the seven scale-out steps `available`. Until then the entry holds the slot (including PARTIAL). A cancel that raced a fill therefore ends FILLED with its position.
- **Finding the order** of an intent: by `OrderID`, then `OrderConfirmID` (if the broker echoes it), then the fallback match for an intent that never learned its `OrderID`: same account, symbol, action and quantity, opened no earlier than the intent minus a clock-skew allowance. The fallback adopts an order only if exactly one fits and no other intent could claim it. With several candidates the intent stays UNKNOWN, keeps every reservation, and `reconcile.ambiguous` is logged once; with none, `reconcile.unresolved`. It is never resolved by guessing, and an UNKNOWN entry is never retried.
- A crash-left **ARMED** intent was never sent (ARMED to SENT has no `await` between), so it is rejected and its reservation released. A **SENT** intent younger than the send grace may still be in flight and is left alone; an older one with no order becomes UNKNOWN.
- **Adoption.** An open order made elsewhere is recorded as an `external` intent (an entry holds a slot but never consumes the daily counters; a sell on a position of ours counts as committed). A position the broker holds that we do not know becomes an `external` position with its scale-out steps, unless an entry of ours on that symbol is still in flight. Shorts are logged and never adopted. Orders an unresolved intent of ours could own are not adopted while it is unresolved.
- Exit fills add to `sold_qty`. A position is CLOSED when the broker reports zero remaining, or from our ledger when its sold quantity has reached the original quantity, or the fills of its own exits (`source = 'app'`) have, with none of ours still in flight, whatever the broker still holds and whatever orders of someone else are open. A smaller holding than ours is a sale made elsewhere and raises `sold_qty`; a larger one is logged and never sold. Both wait while an exit of ours is still unresolved.
- **Shared TradeStation accounts (D49).** Several app clients may use the same key, login and account. The orders listing carries no `OrderConfirmID` (checked in the recorded SIM sample `sim/equity-order/orders-listing.json`; the official spec page is not machine readable, so the field's absence from the spec is (verify)), so an order of another app client cannot be told from one placed in the TradeStation terminal: both are adopted as `external`, and an open sell of either counts against what we can sell, and its fills raise `sold_qty`. This ambiguity is accepted. What we do defend: (1) closing from our own fills, above; (2) when that close happens while the broker still holds the symbol, that holding is not adopted as a new position (nothing of it is protected or sold by us) until the account holds none of the symbol; a genuine external purchase of the same symbol in that window is not adopted either, and an external purchase adopted before the close does not become a position (it waits like the holding does, and its intent is deleted once the account is flat, so it takes no entry slot and never becomes a position).

## Degraded states

| Condition | New entries | Exits and cancels | Protection shown |
| --- | --- | --- | --- |
| token expired or revoked | blocked | blocked (they can't reach the broker); offer «Reconectar» | `unverified` |
| quotes stale or missing | blocked | allowed | `unverified` if server-monitored |
| broker errors or rate-limited | blocked | allowed, never auto-retried | `unverified` until the next good sync |
| outside regular session | blocked | blocked (orders only in session) | unchanged |
| UNKNOWN intent on the position | blocked | blocked for that position | `unverified` |

Each row is detected by the sync pass (`engine/src/sync.ts`) and logged as one event when the condition starts, not on every tick:

| Event | Condition | Loop |
| --- | --- | --- |
| `sync.token_expired` | the broker answered 401 | retries each tick while the token can be renewed; stops when the connection is expired or revoked, until a reconnect. The history reads «TradeStation rechazó o cerró la conexión: reconéctala» (never «vencida»: a refresh TradeStation rejected is recorded as REVOKED, not as an expiry) |
| `sync.rate_limited` | 429 | waits the broker's `Retry-After` (never less than a tick) |
| `sync.broker_error` | rejected, timeout or an unusable answer | retries next tick |
| `sync.items_skipped` | an order or position in a listing could not be read and is not ours (another app client's, or an instrument we do not trade); the event names the operation and field, never the item | the pass goes on without it |
| `sync.recovered` | the next pass succeeded | hold lifted, protection back from `unverified` |
| `sync.unknown_pending` | an UNKNOWN intent remains after the pass | the position stays `unverified` |

A failed pass places a hold (entries blocked, protection `unverified`) and does nothing else: it never sends, cancels or retries an order, so exits and cancels stay as the table says. A good pass lifts the hold with `markReconciled`, using the hold count taken before the broker was read, so a hold that lands during the read survives. Quotes stale or missing block entries in `prepareEntry` (`QUOTE_STALE`, `QUOTE_MISSING`); the protection state they imply is the stop monitor's. Outside the regular session the pass keeps reconciling and the order guards refuse entries and exits.

The UI always shows the reason. **ESTADO NO VERIFICADO** is shown whenever state can't be confirmed with the broker.

## Unreadable items in a listing and diagnosable failures (D49)

- On a shared account the listings hold other clients' orders and positions. The decoder reads them one by one: an item it cannot read is left out and reported (operation, field), so one foreign item never fails the whole pass.
- A left-out item that could be ours degrades the pass instead of being guessed: an order whose id is a non-terminal intent's (or any unreadable order while an intent still lacks its broker id), a position whose symbol is an open position's or an in-flight intent's. Our own order never gets a guessed outcome; the keep-UNKNOWN rules apply.
- `sync.broker_error` carries the operation (`orders`, `historicalOrders`, `positions`, `symbolDetails`, `accounts`), the failure kind and a short code or field name (never a body or a secret). A change of operation or detail logs a new event; the same condition is logged once.
- A rejected intent keeps the broker's reason (`intents.reject_reason`, at most 200 characters), shown in Historial. A refused exit triggers one sync pass at once: if the broker holds none of the symbol, the position closes as an external sale.

