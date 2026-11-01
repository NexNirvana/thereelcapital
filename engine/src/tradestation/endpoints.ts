// The only TradeStation hosts the engine knows. docs/tradestation-integration.md#environments

import type { Mode } from "../mode.ts";
import { logBrokerRequest, startTimer } from "../timing.ts";

export const SIM_API_BASE_URL = "https://sim-api.tradestation.com/v3";

/**
 * The live brokerage host. REAL mode only: a transport for it exists only when the engine variable
 * REAL_TRADING is open (D52, docs/tradestation-integration.md#environments). The host guard allows
 * exactly this line, so every other file imports the constant and never spells the host.
 */
export const LIVE_API_BASE_URL = "https://api.tradestation.com/v3";

/** The API base of a mode. Choosing it opens nothing: the lock checks are in `isAllowedOrigin` and `makeTransport`. */
export function apiBaseUrlFor(mode: Mode): string {
  return mode === "REAL" ? LIVE_API_BASE_URL : SIM_API_BASE_URL;
}

/** Which API host a request may reach: the mode's own, and the live one only with REAL_TRADING open. */
export interface ApiGate {
  readonly mode: Mode;
  readonly realTrading: boolean;
}

/** What the auth calls and the connect flow use: the live origin stays closed. */
export const SIM_GATE: ApiGate = { mode: "SIM", realTrading: false };

/** Auth0 tenant shared by SIM and LIVE keys; it issues tokens and never moves money. */
export const AUTH_BASE_URL = "https://signin.tradestation.com";

export const AUDIENCE = "https://api.tradestation.com";
/**
 * `OptionSpreads` is what TradeStation's scopes page lists for the options endpoints; without it
 * they answer 403 "Missing required scope." (SIM spike 2026-10-22). Tokens issued before it was
 * requested keep the old scopes, so those connections must reconnect.
 */
export const SCOPES = "openid offline_access MarketData ReadAccount Trade OptionSpreads";

/** A broker call that hangs must not hold the Durable Object; a timeout is a failure, not a retry. */
const REQUEST_TIMEOUT_MS = 10_000;

export type BrokerFailure = "REJECTED" | "UNAVAILABLE" | "INVALID_RESPONSE";

export type BrokerResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly failure: BrokerFailure;
      readonly status?: number;
      /** The OAuth `error` code of a refusal, when it is one of the standard ones. Never a body. */
      readonly code?: string;
    };

/** RFC 6749 §5.2. Anything else a server sends is reduced to OTHER_CODE, so no free text is kept. */
const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
]);
const OTHER_CODE = "other";

async function oauthErrorCode(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const code =
    typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
  return typeof code === "string" && OAUTH_ERROR_CODES.has(code) ? code : OTHER_CODE;
}

const AUTH_ORIGIN = new URL(AUTH_BASE_URL).origin;

/** The auth tenant, plus the mode's own API origin; the live one only for REAL with the switch open. */
export function isAllowedOrigin(url: string, gate: ApiGate = SIM_GATE): boolean {
  if (!URL.canParse(url)) return false;
  const { origin } = new URL(url);
  if (origin === AUTH_ORIGIN) return true;
  if (gate.mode === "REAL" && !gate.realTrading) return false;
  return origin === new URL(apiBaseUrlFor(gate.mode)).origin;
}

/**
 * Sends one request and decodes nothing: the callers decode with Schema. Never retries; the error
 * carries a status at most, never a body, because token endpoints can echo submitted values.
 */
export async function send(
  operation: "auth" | "accounts",
  url: string,
  init: RequestInit,
  gate: ApiGate = SIM_GATE,
): Promise<{ ok: true; response: Response } | Extract<BrokerResult<never>, { ok: false }>> {
  // Defense in depth for the REAL_TRADING lock: the only origins this module may reach are the
  // gate's own API host and the auth tenant, whatever a caller passes. Anything else is refused
  // without a request.
  if (!isAllowedOrigin(url, gate)) return { ok: false, failure: "REJECTED" };
  const loggedMode = operation === "auth" ? null : gate.mode;
  const startedAt = startTimer();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    logBrokerRequest(operation, response.status, startedAt, loggedMode);
    if (response.ok) return { ok: true, response };
    // 4xx is the broker saying no (bad secret, bad code); 5xx and 429 are not the client's fault.
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 429;
    if (!rejected) return { ok: false, failure: "UNAVAILABLE", status: response.status };
    return {
      ok: false,
      failure: "REJECTED",
      status: response.status,
      code: await oauthErrorCode(response),
    };
  } catch {
    logBrokerRequest(operation, null, startedAt, loggedMode);
    return { ok: false, failure: "UNAVAILABLE" };
  }
}
