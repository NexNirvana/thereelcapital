// OAuth 2.0 Authorization Code against TradeStation's v3 auth endpoints. Facts and the items still
// marked (verify): docs/tradestation-integration.md#credentials-and-oauth
import { Schema } from "effect";
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
  const sent = await send(`${AUTH_BASE_URL}/oauth/token`, {
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
  const sent = await send(`${AUTH_BASE_URL}/oauth/revoke`, {
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
