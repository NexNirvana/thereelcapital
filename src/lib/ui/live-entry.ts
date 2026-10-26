// What the live price endpoint (/operar/cotizacion) answers and how a screen reads it. The numbers
// are display only (D46): the engine sizes the order itself when it is sent.

export interface LiveEntryPreview {
  readonly symbol: string;
  readonly qty: number;
  readonly sizeMicros: number;
  readonly askMicros: number;
  readonly assetType: "equity" | "option";
}

export type LiveEntry =
  | { readonly status: "ready"; readonly preview: LiveEntryPreview; readonly receivedAt: number }
  | { readonly status: "blocked"; readonly message: string };

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Narrows the endpoint's JSON; anything else is `null`, shown as no update rather than a guess. */
export function parseLiveEntry(body: unknown): LiveEntry | null {
  if (typeof body !== "object" || body === null || !("status" in body)) return null;
  if (body.status === "blocked") {
    return "message" in body && typeof body.message === "string"
      ? { status: "blocked", message: body.message }
      : null;
  }
  if (body.status !== "ready" || !("preview" in body) || !("receivedAt" in body)) return null;
  const { preview, receivedAt } = body;
  if (typeof preview !== "object" || preview === null || !isNumber(receivedAt)) return null;
  const { symbol, qty, sizeMicros, askMicros, assetType } = preview as Record<string, unknown>;
  if (typeof symbol !== "string") return null;
  if (!isNumber(qty) || !isNumber(sizeMicros) || !isNumber(askMicros)) return null;
  if (assetType !== "equity" && assetType !== "option") return null;
  return {
    status: "ready",
    preview: { symbol, qty, sizeMicros, askMicros, assetType },
    receivedAt,
  };
}

/** One read of the endpoint: the answer, or `null` when it could not be read. */
export async function readLiveEntry(
  href: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LiveEntry | null> {
  try {
    const response = await fetcher(href, { headers: { accept: "application/json" }, signal });
    return response.ok ? parseLiveEntry(await response.json()) : null;
  } catch {
    return null;
  }
}
