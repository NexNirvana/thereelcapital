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
   committed  = Σ qty of exit intents in SENT | ACKNOWLEDGED | PARTIAL(unfilled part) | UNKNOWN
   available  = (original_qty − sold_qty) − committed
   ```
   An exit never asks for more than `available`. If protection fires while an exit is pending, it sells only `available`.
5. A position is CLOSED and frees its slot only when the broker reports zero remaining.

## Entries

`prepareEntry` and `sendEntry` (`engine/src/entries.ts`) implement the entry path. The browser names the account and instrument only: SIZE is read from `client_settings`, the quantity is [domain-rules.md §1](domain-rules.md#1-entry-sizing) over the broker's fresh ask and symbol details, and a `confirmedQty` from the client is compared with the server's and never used.

1. `prepareEntry`: connection and reconciliation status, SIZE, symbol details, a fresh quote, `computeEntryQty`, `checkOrder`, then the daily and slot limits as information. No intent, no reservation. It returns a new `intentId` (16 random bytes, base64url, 22 characters, the `OrderConfirmID` limit).
2. `sendEntry`: the same checks again. A different quantity returns `RECONFIRM` and reserves nothing. Otherwise **one synchronous transaction** re-checks reconciliation, the guards and both limits, increments `entry_counters.reserved` and inserts the intent as ARMED with `size_applied`, `quote_json` and `point_value`. The slot is derived from the intent (architecture.md#data-model), so it needs no counter.
3. The intent is set to SENT, then `placeOrder` is called once. A repeat of the same `intentId` (even concurrent) finds the intent and returns its state without calling the broker; the same id for another account or symbol is `INVALID_INPUT`.
4. Outcome: an `OrderID` makes it ACKNOWLEDGED. `Rejected`, `AuthExpired` and `RateLimited` mean the broker did not take the order: REJECTED, and the daily reservation is released in the same transaction as the state change (the slot frees with the state). `Timeout`, `Unknown` or any unexpected failure make it UNKNOWN with both reservations held until reconciliation (#23).

Entries are refused (nothing written) while the connection is unusable, a reconciliation is pending, outside the regular session, or when a limit is reached. Limits never apply to exits or cancels.

## Reconciliation

When: a client opens the app, reconnects TradeStation, the DO starts, any intent is UNKNOWN, and on every sync-loop tick while something is open.

How: read the broker's orders and positions for the client's accounts in that mode → match orders to intents by `OrderID` / `OrderConfirmID` → apply status and fills → adopt positions and orders made outside REEL CAPITAL (another terminal, or existing activity at first connect) as external, so they count against `available` → recompute ledgers, counters and slots → only then accept new entries and resolve UNKNOWN intents.

Entries stay blocked and open positions show `unverified` protection from a failed refresh, a connect or a disconnect until a reconciliation completes; only `markReconciled` lifts the block, and a hold that lands while it waits is not lifted by it.

Reconnecting never resets counters, reservations or scale-out steps.

**Applying broker state** (`engine/src/reconcile.ts`). The sync loop reads orders and positions first, then `reconcile` applies them in ONE synchronous transaction, so counters, the sell ledger and positions never see a half-applied pass. It only records what the broker says; it never places or retries an order.

- An intent's status and `filled_qty` come from its broker order. `filled_qty` never decreases, and an intent never moves backwards (a PARTIAL stays PARTIAL on a stale `ACKNOWLEDGED`, a CANCEL_PENDING stays pending while the order is open). An unmapped broker status keeps the current state and is logged.
- **First fill** of one of our entries: `consumed + 1`, `reserved − 1`, on the market day the reservation was taken. **Terminal with zero fills** (REJECTED or CANCELED): `reserved − 1`, and the slot frees because it is derived from the state.
- **Terminal entry with fills** (FILLED, or CANCELED/REJECTED after a partial fill): the position is created in the same transaction with `original_qty` = the filled quantity, `avg_entry_price` from the broker's average fill, the client's `stop_pct` and `trailing_unlock_pct`, protection `none`, and the seven scale-out steps `available`. Until then the entry holds the slot (including PARTIAL). A cancel that raced a fill therefore ends FILLED with its position.
- Exit fills add to `sold_qty`. A position is CLOSED only when the broker reports zero remaining. A smaller holding than ours is a sale made elsewhere and raises `sold_qty`; a larger one is logged and never sold. Both wait while an exit of ours is still unresolved.

## Degraded states

| Condition | New entries | Exits and cancels | Protection shown |
| --- | --- | --- | --- |
| token expired or revoked | blocked | blocked (they can't reach the broker); offer «Reconectar» | `unverified` |
| quotes stale or missing | blocked | allowed | `unverified` if server-monitored |
| broker errors or rate-limited | blocked | allowed, never auto-retried | `unverified` until the next good sync |
| outside regular session | blocked | blocked (orders only in session) | unchanged |
| UNKNOWN intent on the position | blocked | blocked for that position | `unverified` |

The UI always shows the reason. **ESTADO NO VERIFICADO** is shown whenever state can't be confirmed with the broker.
