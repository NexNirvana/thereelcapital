import { describe, expect, test } from "bun:test";
import { sanitizeRejectReason } from "./reject-reason.ts";

describe("sanitizeRejectReason", () => {
  test("strips a bracketed broker order id", () => {
    expect(sanitizeRejectReason("duplicate order [976408993]")).toBe("duplicate order");
  });

  test("strips a bare id in the middle of the text", () => {
    expect(sanitizeRejectReason("Order 976408993 rejected: no buying power")).toBe(
      "Order rejected: no buying power",
    );
  });

  test("keeps a reason without an id and short numbers", () => {
    expect(sanitizeRejectReason("Insufficient buying power for 12345 shares")).toBe(
      "Insufficient buying power for 12345 shares",
    );
  });

  test("returns null when nothing but an id is left", () => {
    expect(sanitizeRejectReason("[976408993]")).toBeNull();
    expect(sanitizeRejectReason("  ")).toBeNull();
    expect(sanitizeRejectReason(null)).toBeNull();
  });

  test("caps the length at 200 characters", () => {
    expect(sanitizeRejectReason("x".repeat(500))).toHaveLength(200);
  });
});
