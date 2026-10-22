import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "bun:test";
import { createAuth } from "./auth.ts";

// The passkey library checks a ceremony against the rpID and origin it is configured with, and
// rejects any other origin or RP ID itself. What is ours to test is that those two values come from
// APP_ORIGIN alone and never from the request, so a ceremony started or finished from another site
// is held to the app's own origin (docs/auth-and-security.md#configuration).
function authFor(appOrigin: string) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  return createAuth({ DB: sqlite, BETTER_AUTH_SECRET: crypto.randomUUID(), APP_ORIGIN: appOrigin });
}

describe("passkey relying party", () => {
  test("asks for an assertion bound to the app's RP ID, whatever origin the request claims", async () => {
    const auth = authFor("https://thereelcapital.com");
    const { response } = await auth.api.generatePasskeyAuthenticationOptions({
      headers: new Headers({ origin: "https://evil.example", host: "evil.example" }),
      returnHeaders: true,
    });
    expect(response.rpId).toBe("thereelcapital.com");
  });

  test("takes the RP ID from the app origin's host, without port", async () => {
    const auth = authFor("http://localhost:8787");
    const { response } = await auth.api.generatePasskeyAuthenticationOptions({
      headers: new Headers(),
      returnHeaders: true,
    });
    expect(response.rpId).toBe("localhost");
  });
});
