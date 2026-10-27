// OAuth 2.0 Authorization Code against TradeStation's v3 auth endpoints. Facts and the items still
// marked (verify): docs/tradestation-integration.md#credentials-and-oauth
import { Effect, Schema } from "effect";
import { AUDIENCE, AUTH_BASE_URL, SCOPES, send, type BrokerResult } from "./endpoints.ts";

/** The browser is sent here; `client_id` is the only credential-like value that appears in it. */
export function authorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("/authorize", AUTH_BASE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    audience: AUDIENCE,
    redirect_uri: args.redirectUri,
    scope: SCOPES,
    state: args.state,
  }).toString();
  return url.toString();
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)),
  // Present when `offline_access` was granted; its absence makes the connection useless.
  refresh_token: Schema.String.check(Schema.isMinLength(1)),
  expires_in: Schema.Number,
});

interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

export async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<BrokerResult<Tokens>> {
  const sent = await send("auth", `${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  if (!sent.ok) return sent;
  const decoded = Schema.decodeUnknownResult(TokenResponse)(
    await sent.response.json().catch(() => null),
  );
  if (decoded._tag === "Failure") return { ok: false, failure: "INVALID_RESPONSE" };
  const { access_token, refresh_token, expires_in } = decoded.success;
  return {
    ok: true,
    value: { accessToken: access_token, refreshToken: refresh_token, expiresInSeconds: expires_in },
  };
}

/**
 * Revokes ALL refresh tokens of the API key, not only this one (official docs). The body field
 * name is documented twice, as `refresh_token` in the table and `token` in the example, so both are
 * sent: (verify) in the SIM spike.
 */
export async function revokeRefreshToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<BrokerResult<null>> {
  const sent = await send("auth", `${AUTH_BASE_URL}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      token: args.refreshToken,
      refresh_token: args.refreshToken,
    }),
  });
  return sent.ok ? { ok: true, value: null } : sent;
}

const RefreshResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)),
  expires_in: Schema.Number,
  // Only keys configured for rotating refresh tokens get a new one back.
  refresh_token: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});

export interface RefreshedTokens {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  /** null when the response carried none: the stored refresh token stays valid. */
  readonly rotatedRefreshToken: string | null;
}

const RETRIES = 2;

/**
 * The `refresh_token` grant. The only broker call that is retried: it is idempotent for a
 * non-rotating key, and a rotating key only invalidates the old token once it has answered.
 * Retries cover an unreachable or failing TradeStation (5xx, 429, network), never a refusal.
 * The error body of a refused refresh is not documented, so any other 4xx is terminal: (verify).
 */
export async function refreshAccessToken(
  args: { clientId: string; clientSecret: string; refreshToken: string },
  retryDelayMs: number,
): Promise<BrokerResult<RefreshedTokens>> {
  const once = Effect.promise(() =>
    send("auth", `${AUTH_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: args.clientId,
        client_secret: args.clientSecret,
        refresh_token: args.refreshToken,
      }),
    }),
  ).pipe(
    Effect.flatMap((sent) =>
      !sent.ok && sent.failure === "UNAVAILABLE"
        ? Effect.sleep(retryDelayMs).pipe(Effect.andThen(Effect.fail(sent)))
        : Effect.succeed(sent),
    ),
  );
  const sent = await Effect.runPromise(
    Effect.retry(once, { times: RETRIES }).pipe(Effect.catch((last) => Effect.succeed(last))),
  );
  if (!sent.ok) return sent;
  const decoded = Schema.decodeUnknownResult(RefreshResponse)(
    await sent.response.json().catch(() => null),
  );
  if (decoded._tag === "Failure") return { ok: false, failure: "INVALID_RESPONSE" };
  const { access_token, expires_in, refresh_token } = decoded.success;
  return {
    ok: true,
    value: {
      accessToken: access_token,
      expiresInSeconds: expires_in,
      rotatedRefreshToken: refresh_token ?? null,
    },
  };
}
