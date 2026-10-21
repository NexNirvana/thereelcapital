import { Effect } from "effect";
import type { BrokerError } from "../../src/broker/errors.ts";
import type { FetchFn } from "../../src/tradestation/http.ts";

export const SIM_BASE = "https://sim-api.tradestation.com/v3";
export const TOKEN = "access-token-SHOULD-NEVER-LEAK";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly authorization: string | null;
}

/** A scripted fetch: each call takes the next responder; the calls are recorded. */
export function scriptedFetch(...responders: Array<() => Response | Promise<Response>>) {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      authorization: headers.get("authorization"),
    });
    const next = responders[Math.min(calls.length - 1, responders.length - 1)];
    if (next === undefined) throw new Error("no scripted response");
    return next();
  };
  return { fetch: fetchFn, calls };
}

export const okToken = async () => ({ ok: true as const, token: TOKEN });

export const failureOf = <A>(effect: Effect.Effect<A, BrokerError>) =>
  Effect.runPromise(Effect.flip(effect));
export const run = <A>(effect: Effect.Effect<A, BrokerError>) => Effect.runPromise(effect);
