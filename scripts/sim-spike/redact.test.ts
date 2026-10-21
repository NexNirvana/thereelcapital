import { describe, expect, test } from "bun:test";
import { REDACTED, Redactor, maskAccount } from "./redact.ts";

describe("Redactor", () => {
  test("masks account numbers to their last 4 characters", () => {
    expect(maskAccount("SIM1234567")).toBe("****4567");
    const redactor = new Redactor();
    redactor.addAccount("SIM1234567");
    expect(redactor.text("GET /brokerage/accounts/SIM1234567/orders")).toBe(
      "GET /brokerage/accounts/****4567/orders",
    );
    expect(redactor.json({ AccountID: "SIM9999999", nested: [{ Account: "SIM8888888" }] })).toEqual(
      {
        AccountID: "****9999",
        nested: [{ Account: "****8888" }],
      },
    );
  });

  test("removes registered secrets wherever they appear", () => {
    const redactor = new Redactor();
    redactor.addSecret("super-secret");
    expect(redactor.json({ message: "bad super-secret here", ["super-secret"]: 1 })).toEqual({
      message: `bad ${REDACTED} here`,
      [REDACTED]: 1,
    });
  });

  test("removes tokens by key, by JWT shape and from query strings", () => {
    const redactor = new Redactor();
    // Assembled at run time so the repo's secret scan does not flag a fake token.
    const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJl"].join(".");
    const out = JSON.stringify(
      redactor.json({
        access_token: "abc",
        refresh_token: "def",
        client_secret: "ghi",
        header: `Bearer ${jwt}`,
        url: "/callback?code=XYZ&state=ok",
        expires_in: 1200,
      }),
    );
    for (const leaked of ["abc", "def", "ghi", jwt, "XYZ"]) expect(out).not.toContain(leaked);
    expect(out).toContain('"expires_in":1200');
    expect(out).toContain("state=ok");
  });
});
