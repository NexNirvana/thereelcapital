/**
 * Hands the live-price socket to a client's engine (D47). A failed handoff is always logged, by
 * error name and message only, so a 502 in production has a cause in `wrangler tail` (#272).
 */
export type LiveHandoff =
  | { readonly kind: "socket"; readonly webSocket: WebSocket }
  | { readonly kind: "unavailable"; readonly status: 502 | 503 };

export async function handOffLiveSocket(
  stub: { fetch(request: Request): Promise<Response> },
  log: (message: string, detail: Record<string, unknown>) => void = console.error,
): Promise<LiveHandoff> {
  let upstream: Response;
  try {
    // A fresh request: nothing of the browser's (cookies, headers) goes on to the engine.
    upstream = await stub.fetch(
      new Request("https://engine.invalid/live", { headers: { upgrade: "websocket" } }),
    );
  } catch (failure) {
    log("live.handoff failed", {
      name: failure instanceof Error ? failure.name : "unknown",
      message: failure instanceof Error ? failure.message : String(failure),
    });
    return { kind: "unavailable", status: 502 };
  }
  const webSocket = upstream.webSocket ?? null; // undefined outside workerd (unit tests)
  if (upstream.status !== 101 || webSocket === null) {
    log("live.handoff refused", { status: upstream.status, webSocket: webSocket !== null });
    return { kind: "unavailable", status: 503 };
  }
  return { kind: "socket", webSocket };
}
