import { expect, test } from "./test.ts";

const hardened = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

test("pages carry the security headers and a CSP without unsafe-inline scripts", async ({
  request,
}) => {
  const response = await request.get("/acceso");
  const headers = response.headers();
  expect(headers).toMatchObject(hardened);
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toContain("camera=()");

  const csp = Object.fromEntries(
    (headers["content-security-policy"] ?? "").split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
  expect(csp["frame-ancestors"]).toEqual(["'none'"]);
  expect(csp["object-src"]).toEqual(["'none'"]);
  expect(csp["script-src"]).not.toContain("'unsafe-inline'");
  expect(csp["script-src"]).not.toContain("'unsafe-eval'");
  // The Web Analytics beacon Cloudflare injects at the edge (D26) and where it reports.
  expect(csp["script-src"]).toContain("https://static.cloudflareinsights.com");
  expect(csp["connect-src"]).toContain("https://cloudflareinsights.com");
});

test("redirects, endpoints and Better Auth answers carry them too", async ({ request }) => {
  for (const path of ["/", "/api/auth/ok", "/api/recovery-codes"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.headers(), path).toMatchObject(hardened);
  }
});

test("the activation page keeps its stricter no-referrer", async ({ request }) => {
  const response = await request.get("/activar/not-a-real-token");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});
