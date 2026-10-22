// Authorization Code login through a local callback server, then in-memory token handling.
// Tokens are never written anywhere. Request shapes reuse the adapter's authorizeUrl.
import { parsePastedRedirect } from "#lib/domain/connect-redirect.ts";
import { authorizeUrl } from "../../engine/src/tradestation/auth.ts";
import { SpikeAbort, field, type Clock, type Reply, type SimClient } from "./client.ts";
import type { Redactor } from "./redact.ts";

export const DEFAULT_PORT = 3000;

// TradeStation allows these callbacks by default, without a path (auth-code docs): http://localhost
// on ports 80, 3000, 3001, 8080 and 31022. Any other URL has to be added to the key by TradeStation.
export const callbackUrl = (port: number) => `http://localhost:${port}`;

export type CallbackResult =
  { readonly ok: true; readonly code: string } | { readonly ok: false; readonly reason: string };

/** Pure check of the redirect the browser makes to our callback. */
export function readCallback(url: URL, expectedState: string): CallbackResult {
  if (url.pathname !== "/") return { ok: false, reason: "wrong path" };
  const error = url.searchParams.get("error");
  if (error !== null) return { ok: false, reason: `authorization error: ${error}` };
  if (url.searchParams.get("state") !== expectedState)
    return { ok: false, reason: "state mismatch" };
  const code = url.searchParams.get("code");
  return code === null || code === "" ? { ok: false, reason: "no code" } : { ok: true, code };
}

/**
 * Pure check of a redirect address pasted by hand (the page at the callback does not load when
 * the account holder logs in on another computer). Uses the app's own paste rules.
 */
export function readPasted(
  text: string,
  redirectUri: string,
  expectedState: string,
): CallbackResult {
  const pasted = parsePastedRedirect(text, redirectUri);
  if (!pasted.ok) return { ok: false, reason: pasted.reason };
  return pasted.state === expectedState
    ? { ok: true, code: pasted.code }
    : { ok: false, reason: "state mismatch" };
}

/** Starts the callback server and resolves with the authorization code once the owner logs in. */
export function waitForCode(
  port: number,
  expectedState: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      hostname: "localhost",
      port,
      fetch(request) {
        const result = readCallback(new URL(request.url), expectedState);
        if (!result.ok) return new Response("Rejected. You can close this tab.", { status: 400 });
        queueMicrotask(() => {
          void server.stop();
          clearTimeout(timer);
          resolve(result.code);
        });
        return new Response("Logged in. Return to the terminal; you can close this tab.");
      },
    });
    const timer = setTimeout(() => {
      void server.stop();
      reject(new SpikeAbort("Timed out waiting for the login callback."));
    }, timeoutMs);
  });
}

/** The first line typed or piped on stdin. */
async function readLine(): Promise<string> {
  for await (const line of console) return line;
  return "";
}

export function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is printed as well; opening by hand works.
  }
}

/** Holds the tokens in memory and renews the access token a minute before it expires. */
export class TokenSession {
  #accessToken = "";
  #refreshToken = "";
  #expiresAt = 0;
  /** Observations for the report. */
  lastRefresh: { rotated: boolean; expiresIn: number } | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly redactor: Redactor,
    private readonly credentials: { clientId: string; clientSecret: string },
    private readonly client: () => SimClient,
  ) {}

  setFrom(body: unknown): void {
    const access = field(body, "access_token");
    const refresh = field(body, "refresh_token");
    const expires = field(body, "expires_in");
    if (typeof access !== "string") throw new SpikeAbort("Token response had no access_token.");
    this.#accessToken = access;
    this.redactor.addSecret(access);
    if (typeof refresh === "string") {
      this.#refreshToken = refresh;
      this.redactor.addSecret(refresh);
    }
    this.#expiresAt =
      this.clock.now().getTime() + (typeof expires === "number" ? expires : 1200) * 1000;
  }

  hasRefreshToken(): boolean {
    return this.#refreshToken !== "";
  }

  async accessToken(): Promise<string> {
    if (this.#accessToken === "") throw new SpikeAbort("Not logged in.");
    if (this.clock.now().getTime() > this.#expiresAt - 60_000) await this.refresh("auth");
    return this.#accessToken;
  }

  /** The refresh grant. Records whether the response rotated the refresh token. */
  async refresh(step: string): Promise<Reply> {
    const before = this.#refreshToken;
    const reply = await this.client().token(step, "refresh-grant", {
      grant_type: "refresh_token",
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: before,
    });
    if (reply.status !== 200) throw new SpikeAbort(`Refresh refused with status ${reply.status}.`);
    const rotatedTo = field(reply.body, "refresh_token");
    this.lastRefresh = {
      rotated: typeof rotatedTo === "string" && rotatedTo !== before,
      expiresIn: Number(field(reply.body, "expires_in")),
    };
    // Keep the old refresh token when the response carries none (non-rotating key).
    this.setFrom(
      typeof rotatedTo === "string"
        ? reply.body
        : { ...asRecord(reply.body), refresh_token: before },
    );
    return reply;
  }

  /** Probes the refusal path with a made-up refresh token: the error shape is a (verify) item. */
  probeRefusedRefresh(step: string): Promise<Reply> {
    return this.client().token(step, "refresh-refused", {
      grant_type: "refresh_token",
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: "not-a-real-refresh-token",
    });
  }

  async login(args: {
    port: number;
    paste: boolean;
    client: SimClient;
    log: (line: string) => void;
  }): Promise<void> {
    const state = crypto.randomUUID();
    const redirectUri = callbackUrl(args.port);
    const url = authorizeUrl({ clientId: this.credentials.clientId, redirectUri, state });
    let code: string;
    if (args.paste) {
      args.log(
        "Send this URL to the account holder to open and log in (callback " + redirectUri + "):",
      );
      args.log(url);
      args.log("The page after login will not load. Paste its whole address here and press Enter:");
      const result = readPasted(await readLine(), redirectUri, state);
      if (!result.ok) throw new SpikeAbort(`Pasted address rejected: ${result.reason}.`);
      code = result.code;
    } else {
      args.log(`Open this URL if the browser does not open (callback ${redirectUri}):`);
      args.log(url);
      const codePromise = waitForCode(args.port, state, 5 * 60_000);
      openBrowser(url);
      code = await codePromise;
    }
    this.redactor.addSecret(code);
    const reply = await args.client.token("auth", "code-exchange", {
      grant_type: "authorization_code",
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    if (reply.status !== 200)
      throw new SpikeAbort(`Code exchange failed with status ${reply.status}.`);
    this.setFrom(reply.body);
    if (!this.hasRefreshToken())
      throw new SpikeAbort("No refresh token: offline_access not granted.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? { ...value } : {};
}
