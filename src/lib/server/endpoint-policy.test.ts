import { describe, expect, it } from "bun:test";
import { endpointPolicyPlugin } from "./endpoint-policy.ts";

const policy = endpointPolicyPlugin();
const answer = (path: string) =>
  policy.onRequest(new Request(`https://example.com/api/auth${path}`, { method: "POST" }));

describe("endpoint policy", () => {
  it("lets the endpoints the app uses through", async () => {
    expect(await answer("/passkey/verify-authentication")).toBeUndefined();
    expect(await answer("/recovery/redeem")).toBeUndefined();
    expect(await answer("/get-session/")).toBeUndefined();
  });

  it("answers 404 for every other path, known or not yet written", async () => {
    for (const path of ["/admin/set-role", "/admin/anything-new", "/update-user", "/ok", "/"]) {
      expect((await answer(path))?.response.status).toBe(404);
    }
  });
});
