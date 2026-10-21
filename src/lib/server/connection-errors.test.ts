import { describe, expect, it } from "bun:test";
import { connectionErrorFor, connectionErrors } from "./connection-errors.ts";

describe("connectionErrorFor", () => {
  it("maps each known code to its Spanish message", () => {
    for (const [code, message] of Object.entries(connectionErrors)) {
      expect(connectionErrorFor(code)?.message).toBe(message);
    }
  });

  it("ignores codes it does not own, including prototype keys", () => {
    for (const code of [null, "", "nope", "constructor", "__proto__", "<script>"]) {
      expect(connectionErrorFor(code)).toBeNull();
    }
  });
});
