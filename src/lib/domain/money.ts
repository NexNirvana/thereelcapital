/** Money and prices are nonnegative safe-integer micro-dollars (1 USD = 1,000,000).
 * BigInt intermediates keep parsing, formatting and sizing exact.
 */
export function assertMicros(micros: number): void {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new RangeError("Money must be nonnegative safe-integer micro-dollars");
  }
}

export function parseMicros(decimalString: string): number {
  if (decimalString.trim() !== decimalString || !/^\d+(?:\.\d{1,6})?$/.test(decimalString)) {
    throw new RangeError("Expected a nonnegative decimal with at most six decimal places");
  }
  const [whole = "0", fraction = ""] = decimalString.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Money exceeds the safe-integer range");
  }
  return Number(micros);
}

/** Format USD with at least two decimals, preserving every micro-dollar. */
export function formatUsd(micros: number): string {
  assertMicros(micros);
  const value = BigInt(micros);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `$${value / 1_000_000n}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}
