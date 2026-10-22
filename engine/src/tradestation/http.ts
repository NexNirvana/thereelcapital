// The only code that talks HTTP to TradeStation's brokerage and market-data API
// (docs/tradestation-integration.md#environments). Every request goes through `sendRequest`, which
// refuses any URL that is not under the SIM base, so a wrong base can never reach the network.
// Outcomes are mapped to the typed BrokerError set; nothing here decodes a body into domain shapes.

import { Effect, Schema } from "effect";
import {
  AuthExpired,
  RateLimited,
  type RateLimitInfo,
  Rejected,
  Timeout,
  Unknown,
  type BrokerError,
  type BrokerOperation,
} from "../broker/errors.ts";
import type { Mode } from "../mode.ts";
import { SIM_API_BASE_URL } from "./endpoints.ts";

/** A broker call that hangs must not hold the Durable Object. */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_READ_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
/** The 403 body TradeStation sends when the token lacks a scope (SIM spike 2026-10-22). */
const MISSING_SCOPE_MESSAGE = "Missing required scope.";
/** Stable code for that refusal: the client must reconnect to be granted the scope. */
export const MISSING_SCOPE_CODE = "MISSING_SCOPE";
/** Broker messages go to the event log; keep them short. */
const MAX_REASON_LENGTH = 200;

/** Why a transport was refused at construction. Nothing was sent. */
export type TransportRefusal = "MODE_NOT_SIM" | "BASE_URL_NOT_SIM";

/** What the transport needs from `fetch`; a plain function so tests can script it. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** `ok: false` from `AccessTokenSource` covers every non-usable connection (expired, revoked, none). */
export type AccessTokenSource = () => Promise<
  { readonly ok: true; readonly token: string } | { readonly ok: false }
>;

export interface TransportConfig {
  /** Anything but SIM is refused (CLAUDE.md, SIM only). */
  readonly mode: Mode;
  /** Defaults to the SIM base; any other value is refused. Exists so tests can prove the refusal. */
  readonly baseUrl?: string;
  readonly accessToken: AccessTokenSource;
  /** Injected so tests never touch the network. Defaults to the global `fetch`. */
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  /** Extra attempts for idempotent reads after a timeout, a 5xx or a dropped connection. */
  readonly readRetries?: number;
  readonly retryDelayMs?: number;
}

export type { RateLimitInfo };

export interface Transport {
  /** Idempotent GET with bounded retries on transient failures. Resolves to the parsed JSON body. */
  readonly get: (
    operation: BrokerOperation,
    path: string,
    query?: Readonly<Record<string, string>>,
  ) => Effect.Effect<unknown, BrokerError>;
  /** One attempt, never retried: orders may exist after a Timeout or Unknown. */
  readonly send: (
    operation: BrokerOperation,
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, BrokerError>;
  /** An open streaming response (the caller owns closing it) aborted after `timeoutMs`. */
  readonly openStream: (
    operation: BrokerOperation,
    path: string,
    query: Readonly<Record<string, string>>,
    timeoutMs: number,
  ) => Effect.Effect<
    { readonly response: Response; readonly signal: AbortSignal; readonly abort: () => void },
    BrokerError
  >;
  /** The most recent rate-limit headers, whatever the status. */
  readonly rateLimit: () => RateLimitInfo | null;
}

const ErrorBody = Schema.Struct({
  Error: Schema.optionalKey(Schema.String),
  Message: Schema.optionalKey(Schema.String),
});

const isTimeoutError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error.name === "TimeoutError" || error.name === "AbortError");

/** Transient: the same read may succeed a moment later. Decoding and refusals never are. */
const NETWORK_DETAIL = "network";
const HTTP_5XX_PREFIX = "http_5";
const isTransient = (error: BrokerError): boolean =>
  error._tag === "Timeout" ||
  (error._tag === "Unknown" &&
    (error.detail === NETWORK_DETAIL || error.detail.startsWith(HTTP_5XX_PREFIX)));

const toInt = (value: string | null): number | null => {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
};

export function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = toInt(headers.get("x-ratelimit-limit"));
  const remaining = toInt(headers.get("x-ratelimit-remaining"));
  const period = toInt(headers.get("x-ratelimit-period"));
  const reset = toInt(headers.get("x-ratelimit-reset"));
  const resource = headers.get("x-ratelimit-resource");
  if (limit === null && remaining === null && period === null && reset === null) return null;
  return {
    resource,
    limit,
    remaining,
    periodSeconds: period,
    resetMs: reset === null ? null : reset * 1000,
  };
}

async function errorFromResponse(
  operation: BrokerOperation,
  response: Response,
  rateLimit: RateLimitInfo | null,
): Promise<BrokerError> {
  const { status } = response;
  if (status === 401) return new AuthExpired({ operation });
  if (status === 429)
    return new RateLimited({
      operation,
      retryAfterMs: rateLimit?.resetMs ?? null,
      rateLimit: rateLimit ?? undefined,
    });
  if (status >= 500) return new Unknown({ operation, detail: `${HTTP_5XX_PREFIX}xx:${status}` });
  // 4xx other than 401/429: the broker understood the request and refused it.
  const text = await response.text().catch(() => "");
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const body = Schema.decodeUnknownResult(ErrorBody)(parsed);
  const message = body._tag === "Success" ? (body.success.Message ?? "") : "";
  const code = body._tag === "Success" ? body.success.Error : undefined;
  if (status === 403 && message === MISSING_SCOPE_MESSAGE) {
    return new Rejected({ operation, code: MISSING_SCOPE_CODE, reason: message });
  }
  return new Rejected({
    operation,
    code: code !== undefined && code !== "" ? code : `HTTP_${status}`,
    reason: message.slice(0, MAX_REASON_LENGTH),
  });
}

/**
 * Builds the transport, or says why not. Refusing here (not at the first call) means a LIVE mode
 * or a non-SIM base URL never gets as far as holding an access token.
 */
export function makeTransport(
  config: TransportConfig,
):
  | { readonly ok: true; readonly transport: Transport }
  | { readonly ok: false; readonly reason: TransportRefusal } {
  if (config.mode !== "SIM") return { ok: false, reason: "MODE_NOT_SIM" };
  const baseUrl = config.baseUrl ?? SIM_API_BASE_URL;
  if (baseUrl !== SIM_API_BASE_URL) return { ok: false, reason: "BASE_URL_NOT_SIM" };

  const doFetch: FetchFn = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readRetries = config.readRetries ?? DEFAULT_READ_RETRIES;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastRateLimit: RateLimitInfo | null = null;

  const urlFor = (path: string, query: Readonly<Record<string, string>> = {}): string => {
    const search = new URLSearchParams(query).toString();
    return `${baseUrl}${path}${search === "" ? "" : `?${search}`}`;
  };

  /** Every request passes here: the SIM check is the last line before the network. */
  const sendRequest = (
    operation: BrokerOperation,
    url: string,
    init: { method: string; body?: string; signal: AbortSignal },
  ): Effect.Effect<Response, BrokerError> =>
    Effect.gen(function* () {
      if (!url.startsWith(`${SIM_API_BASE_URL}/`)) {
        return yield* Effect.fail(
          new Rejected({ operation, code: "BASE_URL_NOT_SIM", reason: "request refused" }),
        );
      }
      const access = yield* Effect.tryPromise({
        try: () => config.accessToken(),
        catch: () => new AuthExpired({ operation }),
      });
      if (!access.ok) return yield* Effect.fail(new AuthExpired({ operation }));
      const response = yield* Effect.tryPromise({
        try: () =>
          doFetch(url, {
            method: init.method,
            headers: {
              authorization: `Bearer ${access.token}`,
              accept: "application/json",
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(init.body === undefined ? {} : { body: init.body }),
            signal: init.signal,
          }),
        catch: (error): BrokerError =>
          isTimeoutError(error)
            ? new Timeout({ operation })
            : new Unknown({ operation, detail: NETWORK_DETAIL }),
      });
      lastRateLimit = parseRateLimit(response.headers) ?? lastRateLimit;
      if (response.ok) return response;
      return yield* Effect.fail(
        yield* Effect.promise(() =>
          errorFromResponse(operation, response, parseRateLimit(response.headers)),
        ),
      );
    });

  const readJson = (operation: BrokerOperation, response: Response) =>
    Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (error): BrokerError =>
        isTimeoutError(error)
          ? new Timeout({ operation })
          : new Unknown({
              operation,
              // Only a malformed body is an invalid response; a body cut off mid-read is a dropped connection.
              detail: error instanceof SyntaxError ? "invalid_response" : NETWORK_DETAIL,
            }),
    });

  const once = (
    operation: BrokerOperation,
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: Readonly<Record<string, string>> | undefined,
    body: unknown,
  ): Effect.Effect<unknown, BrokerError> =>
    Effect.gen(function* () {
      const response = yield* sendRequest(operation, urlFor(path, query), {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return yield* readJson(operation, response);
    });

  const transport: Transport = {
    get: (operation, path, query) =>
      once(operation, "GET", path, query, undefined).pipe(
        Effect.tapError((error) => (isTransient(error) ? Effect.sleep(retryDelayMs) : Effect.void)),
        Effect.retry({ times: readRetries, while: isTransient }),
      ),
    // No Effect.retry here, ever: a repeated place or cancel could act twice (order-lifecycle.md rule 2).
    send: (operation, method, path, body) => once(operation, method, path, undefined, body),
    openStream: (operation, path, query, streamTimeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException("", "TimeoutError")),
        streamTimeoutMs,
      );
      return sendRequest(operation, urlFor(path, query), {
        method: "GET",
        signal: controller.signal,
      }).pipe(
        Effect.map((response) => ({
          response,
          signal: controller.signal,
          abort: () => {
            clearTimeout(timer);
            controller.abort();
          },
        })),
        Effect.tapError(() => Effect.sync(() => clearTimeout(timer))),
      );
    },
    rateLimit: () => lastRateLimit,
  };
  return { ok: true, transport };
}
