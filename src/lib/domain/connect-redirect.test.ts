import { describe, expect, it } from "bun:test";
import { connectRedirectUri, parsePastedRedirect } from "./connect-redirect";

describe("connectRedirectUri", () => {
  it("uses the bare localhost URL in paste mode, whatever the app origin", () => {
    expect(connectRedirectUri("https://thereelcapital.com", "paste")).toBe("http://localhost:3000");
  });

  it("uses the registered callback of the app origin in registered mode", () => {
    expect(connectRedirectUri("https://thereelcapital.com/", "registered")).toBe(
      "https://thereelcapital.com/conexion/callback",
    );
  });

  it("defaults to paste mode", () => {
    expect(connectRedirectUri("https://thereelcapital.com")).toBe("http://localhost:3000");
  });
});

describe("parsePastedRedirect", () => {
  it("reads code and state from the full address, trimming spaces", () => {
    expect(parsePastedRedirect("  http://localhost:3000/?code=abc&state=def\n")).toEqual({
      ok: true,
      code: "abc",
      state: "def",
    });
    expect(parsePastedRedirect("http://localhost:3000?code=a%2Fb&state=s")).toEqual({
      ok: true,
      code: "a/b",
      state: "s",
    });
  });

  it("rejects any other origin, port, scheme, path, credentials or fragment", () => {
    for (const address of [
      "http://localhost:3001/?code=a&state=s",
      "https://localhost:3000/?code=a&state=s",
      "http://localhost/?code=a&state=s",
      "http://127.0.0.1:3000/?code=a&state=s",
      "https://thereelcapital.com/conexion/callback?code=a&state=s",
      "http://localhost:3000/conexion/callback?code=a&state=s",
      "http://user@localhost:3000/?code=a&state=s",
      "http://localhost:3000/?code=a&state=s#x",
    ]) {
      expect(parsePastedRedirect(address)).toEqual({ ok: false, reason: "MALFORMED" });
    }
  });

  it("rejects extra or repeated parameters", () => {
    expect(parsePastedRedirect("http://localhost:3000/?code=a&state=s&x=1")).toEqual({
      ok: false,
      reason: "MALFORMED",
    });
    expect(parsePastedRedirect("http://localhost:3000/?code=a&code=b&state=s")).toEqual({
      ok: false,
      reason: "MALFORMED",
    });
  });

  it("reports an error parameter as a denial", () => {
    expect(
      parsePastedRedirect("http://localhost:3000/?error=access_denied&error_description=no"),
    ).toEqual({ ok: false, reason: "DENIED" });
  });

  it("reports a missing or empty code or state", () => {
    expect(parsePastedRedirect("http://localhost:3000/?state=s")).toEqual({
      ok: false,
      reason: "MISSING_CODE",
    });
    expect(parsePastedRedirect("http://localhost:3000/?code=a&state=")).toEqual({
      ok: false,
      reason: "MISSING_STATE",
    });
    expect(parsePastedRedirect("http://localhost:3000")).toEqual({
      ok: false,
      reason: "MISSING_CODE",
    });
  });

  it("rejects text that is not an address, and oversized input", () => {
    for (const text of ["", "   ", "code=a&state=s", "not a url"]) {
      expect(parsePastedRedirect(text)).toEqual({ ok: false, reason: "MALFORMED" });
    }
    expect(parsePastedRedirect(`http://localhost:3000/?code=${"a".repeat(5000)}&state=s`)).toEqual({
      ok: false,
      reason: "MALFORMED",
    });
  });
});
