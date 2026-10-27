// Latency probes for the Durable Object (#279): one JSON line per broker request and D1 query, plus
// the colo once, read with `wrangler tail reel-engine --format json` (docs/tradestation-integration.md#reading-the-latency-events).
// Fields are fixed and coarse on purpose: an operation class, a status and milliseconds. Never a URL,
// query, symbol, account id, token or body.

import type { BrokerOperation } from "./broker/errors.ts";

/** Wall-clock milliseconds; sub-millisecond precision is unavailable in workerd and not needed. */
const nowMs = (): number => Date.now();

function emit(event: string, fields: Readonly<Record<string, string | number | null>>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** `status` is null when no response arrived (timeout, network); `ms` is then the time to the failure. */
export function logBrokerRequest(
  operation: BrokerOperation | "auth",
  status: number | null,
  startedAt: number,
): void {
  emit("broker.request", { operation, status, ms: nowMs() - startedAt });
}

export const startTimer = nowMs;

/** The only D1 reads the probe names; the table in docs/tradestation-integration.md lists them. */
export type D1QueryName = "connection_row" | "size_usd" | "protection_settings" | "token_row";

/** Times a D1 query that is already awaited; `name` is a fixed label, never built from input. */
export async function timedD1<T>(name: D1QueryName, query: Promise<T>): Promise<T> {
  const startedAt = nowMs();
  try {
    return await query;
  } finally {
    emit("d1.query", { name, ms: nowMs() - startedAt });
  }
}

const TRACE_URL = "https://cloudflare.com/cdn-cgi/trace";
const TRACE_TIMEOUT_MS = 5_000;

/** Logs only the `colo` line of Cloudflare's trace, once per call; failures are silent (a probe). */
export async function logColo(
  doFetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<void> {
  try {
    const response = await doFetch(TRACE_URL, { signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) });
    const colo = /^colo=([A-Z0-9]{2,5})$/m.exec(await response.text())?.[1];
    if (colo !== undefined) emit("do.colo", { colo });
  } catch {
    // A diagnostic only: no colo line, nothing else to do.
  }
}
