// The spike's only door to the network. Every request passes `assertSimOrigin` first, and every
// order call passes `orderGuard` (flag, regular session, account in the SIM list from the SIM host).
// SIM only, no real money: nothing here knows any other TradeStation host.
import { isRegularSession, type InstrumentKind } from "#lib/domain/calendar.ts";
import {
  AUTH_BASE_URL,
  SIM_API_BASE_URL,
  isAllowedOrigin,
} from "../../engine/src/tradestation/endpoints.ts";
import { Redactor } from "./redact.ts";

export class SpikeAbort extends Error {}

const SIM_ORIGIN = new URL(SIM_API_BASE_URL).origin;

/** Throws unless `url` is https on exactly the SIM API host or the OAuth host. */
export function assertSimOrigin(url: string): void {
  if (!URL.canParse(url) || new URL(url).protocol !== "https:" || !isAllowedOrigin(url)) {
    throw new SpikeAbort("Refusing a request outside the SIM API and the OAuth host.");
  }
}

export interface SampleSink {
  save(step: string, name: string, sample: unknown): void;
}

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface Clock {
  now(): Date;
}

export interface ClientDeps {
  readonly fetchFn: typeof fetch;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly samples: SampleSink;
  readonly ordersEnabled: boolean;
  /** Returns a valid access token, refreshing it first when needed. */
  readonly accessToken: () => Promise<string>;
}

const TIMEOUT_MS = 20_000;

export class SimClient {
  /** Account ids listed by GET /brokerage/accounts on the SIM host: the only ones orders may use. */
  readonly simAccounts = new Map<string, { type: string; status: string }>();
  /** Every X-RateLimit-* header seen, last value per name. */
  readonly rateLimitHeaders = new Map<string, string>();
  readonly #deps: ClientDeps;

  constructor(deps: ClientDeps) {
    this.#deps = deps;
  }

  /** Read-only call on the SIM API. Order execution paths are refused here. */
  async get(
    step: string,
    name: string,
    path: string,
    query?: Record<string, string>,
  ): Promise<Reply> {
    if (path.startsWith("/orderexecution")) throw new SpikeAbort("Order calls go through order().");
    const reply = await this.#call(`${SIM_API_BASE_URL}${path}${queryString(query)}`, {
      method: "GET",
    });
    this.#record(step, name, "GET", path, undefined, reply);
    return reply;
  }

  /** Loads the SIM account list (needed before any order call). */
  async loadAccounts(step: string): Promise<Reply> {
    const reply = await this.get(step, "accounts", "/brokerage/accounts");
    const accounts = field(reply.body, "Accounts");
    if (reply.status === 200 && Array.isArray(accounts)) {
      this.simAccounts.clear();
      for (const account of accounts) {
        const id = field(account, "AccountID");
        if (typeof id === "string") {
          this.#deps.redactor.addAccount(id);
          this.simAccounts.set(id, {
            type: String(field(account, "AccountType")),
            status: String(field(account, "Status")),
          });
        }
      }
    }
    return reply;
  }

  /** The only way to call /orderexecution. Throws SpikeAbort unless every precondition holds. */
  async order(
    step: string,
    name: string,
    call: {
      method: "POST" | "DELETE";
      path: string;
      body?: unknown;
      accountId: string;
      kind: InstrumentKind;
    },
  ): Promise<Reply> {
    orderGuard({
      ordersEnabled: this.#deps.ordersEnabled,
      now: this.#deps.clock.now(),
      kind: call.kind,
      accountId: call.accountId,
      simAccounts: this.simAccounts,
    });
    if (!call.path.startsWith("/orderexecution/")) throw new SpikeAbort("Not an order path.");
    const url = `${SIM_API_BASE_URL}${call.path}`;
    // Defense in depth: an order never goes anywhere but the SIM API origin.
    if (new URL(url).origin !== SIM_ORIGIN) throw new SpikeAbort("Order URL is not the SIM host.");
    const reply = await this.#call(url, {
      method: call.method,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    this.#record(step, name, call.method, call.path, call.body, reply);
    return reply;
  }

  /** POST to the OAuth token endpoint with a form body. Samples are saved redacted. */
  async token(step: string, name: string, form: Record<string, string>): Promise<Reply> {
    const url = `${AUTH_BASE_URL}/oauth/token`;
    const reply = await this.#call(url, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      anonymous: true,
    });
    this.#record(step, name, "POST", "/oauth/token", form, reply);
    return reply;
  }

  /** Streams NDJSON lines until `stop` returns true for a parsed line or the time runs out. */
  async stream(
    step: string,
    name: string,
    path: string,
    stop: (message: unknown) => boolean,
    maxMs: number,
  ): Promise<{ status: number; messages: unknown[] }> {
    const url = `${SIM_API_BASE_URL}${path}`;
    assertSimOrigin(url);
    const token = await this.#deps.accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), maxMs);
    const messages: unknown[] = [];
    let status = 0;
    try {
      const response = await this.#deps.fetchFn(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      status = response.status;
      this.#noteRateLimits(response.headers);
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (reader !== undefined && !done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter((text) => text.trim() !== "")) {
          const message = parseJson(line);
          messages.push(message);
          if (stop(message)) done = true;
        }
      }
      controller.abort();
    } catch (error) {
      // Only the abort at the deadline or after EndSnapshot is expected; anything else is real.
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    } finally {
      clearTimeout(timer);
    }
    this.#deps.samples.save(
      step,
      name,
      this.#deps.redactor.json({
        request: { method: "GET", path },
        response: { status, messages: messages.slice(0, 12), totalMessages: messages.length },
      }),
    );
    return { status, messages };
  }

  async #call(
    url: string,
    init: {
      method: string;
      body?: BodyInit;
      headers?: Record<string, string>;
      anonymous?: boolean;
    },
  ): Promise<Reply> {
    assertSimOrigin(url);
    const headers: Record<string, string> = { ...init.headers };
    if (init.anonymous !== true) {
      headers.authorization = `Bearer ${await this.#deps.accessToken()}`;
      if (typeof init.body === "string") headers["content-type"] = "application/json";
    }
    const response = await this.#deps.fetchFn(url, {
      method: init.method,
      body: init.body,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    this.#noteRateLimits(response.headers);
    const text = await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text === "" ? null : parseJson(text),
    };
  }

  #noteRateLimits(headers: Headers): void {
    for (const [name, value] of headers.entries()) {
      if (name.toLowerCase().startsWith("x-ratelimit") || name.toLowerCase() === "retry-after") {
        this.rateLimitHeaders.set(name.toLowerCase(), value);
      }
    }
  }

  #record(
    step: string,
    name: string,
    method: string,
    path: string,
    requestBody: unknown,
    reply: Reply,
  ): void {
    const interesting = Object.fromEntries(
      Object.entries(reply.headers).filter(
        ([key]) => key.startsWith("x-ratelimit") || key === "retry-after",
      ),
    );
    this.#deps.samples.save(
      step,
      name,
      this.#deps.redactor.json({
        request: { method, path, body: requestBody },
        response: { status: reply.status, headers: interesting, body: reply.body },
      }),
    );
  }
}

export interface OrderPreconditions {
  readonly ordersEnabled: boolean;
  readonly now: Date;
  readonly kind: InstrumentKind;
  readonly accountId: string;
  readonly simAccounts: ReadonlyMap<string, unknown>;
}

/** Refuses unless the flag is set, the regular session is open and the account is SIM-listed. */
export function orderGuard(args: OrderPreconditions): void {
  if (!args.ordersEnabled) throw new SpikeAbort("Order calls need --confirm-sim-orders.");
  const session = isRegularSession({ kind: args.kind }, args.now);
  if (!session.open) throw new SpikeAbort(`Outside the regular session: ${session.reason}.`);
  if (!args.simAccounts.has(args.accountId)) {
    throw new SpikeAbort("Account is not in the SIM accounts list from the SIM host.");
  }
}

function queryString(query: Record<string, string> | undefined): string {
  return query === undefined ? "" : `?${new URLSearchParams(query).toString()}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unparsed: text.slice(0, 500) };
  }
}

/** Reads `key` from an unknown value without casts. */
export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}
