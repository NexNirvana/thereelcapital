// REAL accounts (lock 3 of D52): which live accounts this client's connection may trade. The live
// host lists them; an account SIM also lists is not a live account, and one bound to another client
// (a shared login, D49) is never this client's. docs/tradestation-integration.md#real-accounts
import { attempt } from "./broker/attempt.ts";
import type { BrokerAdapterShape } from "./broker/adapter.ts";
import { logEvent } from "./events.ts";

/** The event every listing writes; `data` is `{ stored, skipped }`, counts only. */
export const REAL_ACCOUNTS_LISTED = "real_accounts.listed";

export interface RealAccountsContext {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly db: D1Database;
  readonly userId: string;
  readonly now: number;
}

export type RealAccountsResult =
  | { readonly ok: true; readonly stored: number; readonly skipped: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Lists the accounts through the REAL broker (which exists only with the switch open), keeps the
 * active Cash and Margin ones SIM did not list and that no other client has bound, and stores them
 * as this client's REAL accounts. A failed listing changes nothing.
 */
export async function listRealAccounts(
  ctx: RealAccountsContext,
  real: BrokerAdapterShape,
): Promise<RealAccountsResult> {
  const simIds = new Set(
    ctx.sql
      .exec<{ account_id: string }>("SELECT account_id FROM broker_accounts WHERE mode = 'SIM'")
      .toArray()
      .map((row) => row.account_id),
  );
  // Without SIM accounts there is nothing to tell the two hosts apart by: wait for a connection.
  if (simIds.size === 0) return { ok: false, reason: "NOT_CONNECTED" };

  const listed = await attempt(real.accounts());
  if (!listed.ok) return { ok: false, reason: listed.error._tag };

  const candidates = listed.value.filter(
    (account) =>
      account.active &&
      (account.kind === "Cash" || account.kind === "Margin") &&
      !simIds.has(account.accountId),
  );
  const mine: Array<{ accountId: string; kind: "Cash" | "Margin" }> = [];
  for (const account of candidates) {
    // Claim first, then read the owner: the primary key lets exactly one racer insert.
    await ctx.db
      .prepare(
        "INSERT INTO real_account_bindings (account_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT (account_id) DO NOTHING",
      )
      .bind(account.accountId, ctx.userId, ctx.now)
      .run();
    const owner = await ctx.db
      .prepare("SELECT user_id FROM real_account_bindings WHERE account_id = ?")
      .bind(account.accountId)
      .first<{ user_id: string }>();
    if (owner?.user_id === ctx.userId && (account.kind === "Cash" || account.kind === "Margin")) {
      mine.push({ accountId: account.accountId, kind: account.kind });
    }
  }
  const skipped = candidates.length - mine.length;

  // One synchronous block: a reader sees the old list or the new one, never half of it.
  ctx.storage.transactionSync(() => {
    ctx.sql.exec("DELETE FROM broker_accounts WHERE mode = 'REAL'");
    for (const account of mine) {
      ctx.sql.exec(
        "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('REAL', ?, ?)",
        account.accountId,
        account.kind,
      );
    }
  });
  // Counts only: an account id never reaches the event log.
  if (skipped > 0) {
    logEvent({ ...ctx, mode: "REAL" }, "warn", "real_accounts.bound_elsewhere", { skipped });
  }
  // The latest listing alone is the current outcome (the admin reads it), so it carries both counts.
  logEvent({ ...ctx, mode: "REAL" }, "info", REAL_ACCOUNTS_LISTED, {
    stored: mine.length,
    skipped,
  });
  return { ok: true, stored: mine.length, skipped };
}

/** The client's connection ended (disconnect), so its live accounts are free to bind elsewhere. */
export function unbindRealAccounts(db: D1Database, userId: string): Promise<unknown> {
  return db.prepare("DELETE FROM real_account_bindings WHERE user_id = ?").bind(userId).run();
}
