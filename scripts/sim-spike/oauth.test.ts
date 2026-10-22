import { describe, expect, test } from "bun:test";
import { callbackUrl, readCallback, readPasted } from "./oauth.ts";

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

describe("pasted redirect", () => {
  const uri = callbackUrl(3000);

  test("accepts the pasted address with the code, ignoring surrounding whitespace", () => {
    expect(readPasted(" http://localhost:3000/?code=c&state=s\n", uri, "s")).toEqual({
      ok: true,
      code: "c",
    });
  });

  test("accepts the default port in either spelling", () => {
    for (const text of [
      "http://localhost:80/?code=c&state=s",
      "http://localhost/?code=c&state=s",
    ]) {
      expect(readPasted(text, callbackUrl(80), "s")).toEqual({ ok: true, code: "c" });
    }
  });

  test("rejects userinfo, a fragment and extra parameters like the app does", () => {
    for (const text of [
      "http://user@localhost:3000/?code=c&state=s",
      "http://localhost:3000/?code=c&state=s#x",
      "http://localhost:3000/?code=c&state=s&extra=1",
    ]) {
      expect(readPasted(text, uri, "s").ok).toBe(false);
    }
  });

  test("rejects a wrong state, an error, a missing code, another origin and text", () => {
    for (const text of [
      "http://localhost:3000/?code=c&state=other",
      "http://localhost:3000/?error=access_denied&state=s",
      "http://localhost:3000/?state=s",
      "http://localhost:3001/?code=c&state=s",
      "https://evil.example/?code=c&state=s",
      "code=c&state=s",
      "",
    ]) {
      expect(readPasted(text, uri, "s").ok).toBe(false);
    }
  });
});
