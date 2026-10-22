import { describe, expect, test } from "bun:test";
import { scanText } from "./check-client-bundle.ts";

describe("scanText", () => {
  test("flags secret names and token shapes without echoing them", () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.${"s".repeat(20)}`;
    const found = scanText("a.js", `const k="CREDENTIALS_KEY";const t="${jwt}"`);
    expect(found.map((f) => f.what)).toEqual(["secret name CREDENTIALS_KEY", "JWT pattern"]);
    expect(JSON.stringify(found)).not.toContain(jwt);
  });

  test("flags classic and fine-grained GitHub tokens", () => {
    expect(scanText("a.js", `"ghp_${"A".repeat(36)}"`)).toEqual([
      { file: "a.js", what: "GitHub token pattern" },
    ]);
    expect(scanText("a.js", `"github_pat_${"A".repeat(60)}"`)).toEqual([
      { file: "a.js", what: "GitHub token pattern" },
    ]);
  });

  test("ignores better-auth's env accessor but not the name anywhere else", () => {
    const accessor = "get BETTER_AUTH_SECRET(){return W(`BETTER_AUTH_SECRET`)}";
    expect(scanText("a.js", accessor)).toEqual([]);
    expect(scanText("a.js", `${accessor};x("BETTER_AUTH_SECRET")`)).toHaveLength(1);
  });

  test("passes ordinary application code", () => {
    expect(scanText("a.js", "export const x = 1; fetch('/api/auth/ok')")).toEqual([]);
  });
});
