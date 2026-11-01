import { Schema } from "effect";
import { apiBaseUrlFor, send, type ApiGate, type BrokerResult } from "./endpoints.ts";

// (verify) Field names come from docs/tradestation-integration.md; the exact `Status` values are
// not in the pages we could read, so "Active" is matched case-insensitively and checked in the spike.
const AccountsResponse = Schema.Struct({
  Accounts: Schema.Array(
    Schema.Struct({
      AccountID: Schema.String.check(Schema.isMinLength(1)),
      AccountType: Schema.String,
      Status: Schema.String,
    }),
  ),
});

export interface BrokerAccount {
  readonly accountId: string;
  readonly accountType: "Cash" | "Margin";
}

/**
 * Only active Cash and Margin accounts can trade equities and options (Futures and DVP cannot).
 * The mode's own host lists them: that listing is the proof an account belongs to the mode.
 */
export async function listTradableAccounts(
  gate: ApiGate,
  accessToken: string,
): Promise<BrokerResult<readonly BrokerAccount[]>> {
  const url = `${apiBaseUrlFor(gate.mode)}/brokerage/accounts`;
  const sent = await send(
    "accounts",
    url,
    { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
    gate,
  );
  if (!sent.ok) return sent;
  const decoded = Schema.decodeUnknownResult(AccountsResponse)(
    await sent.response.json().catch(() => null),
  );
  if (decoded._tag === "Failure") return { ok: false, failure: "INVALID_RESPONSE" };
  const accounts: BrokerAccount[] = [];
  for (const { AccountID, AccountType, Status } of decoded.success.Accounts) {
    if (Status.toLowerCase() !== "active") continue;
    if (AccountType === "Cash" || AccountType === "Margin") {
      accounts.push({ accountId: AccountID, accountType: AccountType });
    }
  }
  return { ok: true, value: accounts };
}
