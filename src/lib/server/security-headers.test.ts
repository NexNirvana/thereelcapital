import { describe, expect, it } from "bun:test";
import { withSecurityHeaders } from "./security-headers.ts";

describe("security headers", () => {
  it("adds HSTS with subdomains, nosniff, framing and opener protection", () => {
    const { headers } = withSecurityHeaders(new Response("ok"));
    expect(headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("keeps the no-referrer a route already set", () => {
    const route = new Response("ok", { headers: { "referrer-policy": "no-referrer" } });
    expect(withSecurityHeaders(route).headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("works on a redirect, whose own headers are immutable", () => {
    const redirect = withSecurityHeaders(Response.redirect("https://example.com/", 303));
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("x-frame-options")).toBe("DENY");
  });
});
