// The only TradeStation hosts the engine knows. docs/tradestation-integration.md#environments

/** SIM only, no real money. LIVE is not a configured environment and has no constant. */
export const SIM_API_BASE_URL = "https://sim-api.tradestation.com/v3";

/** Auth0 tenant shared by SIM and LIVE keys; it issues tokens and never moves money. */
export const AUTH_BASE_URL = "https://signin.tradestation.com";

export const AUDIENCE = "https://api.tradestation.com";
export const SCOPES = "openid offline_access MarketData ReadAccount Trade";

/** A broker call that hangs must not hold the Durable Object; a timeout is a failure, not a retry. */
const REQUEST_TIMEOUT_MS = 10_000;

export type BrokerFailure = "REJECTED" | "UNAVAILABLE" | "INVALID_RESPONSE";

export type BrokerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: BrokerFailure; readonly status?: number };

/**
 * Sends one request and decodes nothing: the callers decode with Schema. Never retries; the error
 * carries a status at most, never a body, because token endpoints can echo submitted values.
 */
export async function send(
  url: string,
  init: RequestInit,
): Promise<{ ok: true; response: Response } | Extract<BrokerResult<never>, { ok: false }>> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.ok) return { ok: true, response };
    // 4xx is the broker saying no (bad secret, bad code); 5xx and 429 are not the client's fault.
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 429;
    return { ok: false, failure: rejected ? "REJECTED" : "UNAVAILABLE", status: response.status };
  } catch {
    return { ok: false, failure: "UNAVAILABLE" };
  }
}
