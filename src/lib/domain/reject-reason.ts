const MAX_LENGTH = 200;

/**
 * The broker's refusal text as it may be stored and shown: broker order ids (runs of six or more
 * digits, bare or bracketed) are removed because the history never exposes them
 * (docs/screens-and-flows.md, `/historial`), and the text is cut short. Null when nothing is left.
 */
export function sanitizeRejectReason(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw
    .replace(/[[(]?\s*\d{6,}\s*[\])]?/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.\-–]+|[\s:;,.\-–]+$/g, "")
    .slice(0, MAX_LENGTH)
    .trim();
  return cleaned === "" ? null : cleaned;
}
