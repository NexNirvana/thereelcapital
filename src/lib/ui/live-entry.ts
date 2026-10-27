// What the live price endpoint (/operar/cotizacion) answers and how a screen reads it, by polling
// (D46) or from the socket's pushes (D47). The numbers are display only: the engine sizes the order
// itself when it is sent.

import type { LiveMessage } from "#lib/domain/live-protocol.ts";
import { choiceApplied, type SizeChoice } from "#lib/domain/sizing.ts";
import { blockMessage } from "./new-entry.ts";

export interface LiveEntryPreview {
  readonly symbol: string;
  readonly qty: number;
  readonly sizeMicros: number;
  /** The choice the engine applied; an answer for another one is never shown (see `entryFromMessage`). */
  readonly sizeChoice: SizeChoice;
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
  const {
    symbol,
    qty,
    sizeMicros,
    askMicros,
    assetType,
    sizeChoice = "full",
  } = preview as Record<string, unknown>;
  if (typeof symbol !== "string") return null;
  if (sizeChoice !== "full" && sizeChoice !== "down25") return null;
  if (!isNumber(qty) || !isNumber(sizeMicros) || !isNumber(askMicros)) return null;
  if (assetType !== "equity" && assetType !== "option") return null;
  return {
    status: "ready",
    preview: { symbol, qty, sizeMicros, sizeChoice, askMicros, assetType },
    receivedAt,
  };
}

/** Shown instead of a quantity the engine sized for another SIZE choice than the one on screen. */
export const SIZE_CHOICE_MISMATCH =
  "El servicio aún no aplica la opción de SIZE elegida. Recarga la página.";

/**
 * A ready answer is trusted only for the choice the screen asked for: otherwise the quantity shown
 * would not be the one an order sends (deploy skew, docs/architecture.md#deploying).
 */
export function matchingChoice(entry: LiveEntry, requested: SizeChoice): LiveEntry {
  return entry.status === "ready" && !choiceApplied(requested, entry.preview.sizeChoice)
    ? { status: "blocked", message: SIZE_CHOICE_MISMATCH }
    : entry;
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

/**
 * What a pushed message does to the entry on screen: the new answer, or `null` for no change. A
 * heartbeat only refreshes the time of a price that is still current.
 */
export function entryFromMessage(
  message: LiveMessage,
  current: LiveEntry | null,
): LiveEntry | null {
  if (message.type === "alive") {
    return current?.status === "ready" ? { ...current, receivedAt: message.receivedAt } : null;
  }
  if (message.type !== "entry") return null;
  const { update } = message;
  if (update.status === "blocked") {
    return { status: "blocked", message: blockMessage(update.reasons) };
  }
  const { symbol, qty, sizeMicros, sizeChoice, askMicros, assetType } = update;
  return {
    status: "ready",
    preview: { symbol, qty, sizeMicros, sizeChoice, askMicros, assetType },
    receivedAt: message.receivedAt,
  };
}
