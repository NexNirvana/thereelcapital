import { describe, expect, test } from "bun:test";
import { callbackUrl, readCallback } from "./oauth.ts";

describe("callback", () => {
  test("uses a bare localhost callback, as TradeStation allows by default", () => {
    expect(callbackUrl(3000)).toBe("http://localhost:3000");
  });

  test("accepts the code when the state matches", () => {
    expect(readCallback(new URL("http://localhost:3000/?code=c&state=s"), "s")).toEqual({
      ok: true,
      code: "c",
    });
  });

  test("rejects a wrong state, an error, a missing code and another path", () => {
    for (const url of [
      "http://localhost:3000/?code=c&state=other",
      "http://localhost:3000/?error=access_denied&state=s",
      "http://localhost:3000/?state=s",
      "http://localhost:3000/elsewhere?code=c&state=s",
    ]) {
      expect(readCallback(new URL(url), "s").ok).toBe(false);
    }
  });
});
