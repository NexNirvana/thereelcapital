import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth } from "#lib/server/auth.ts";

const baseURL = "https://thereelcapital.com";
const auth = createAuth({
  DB: env.DB,
  BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  APP_ORIGIN: baseURL,
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function countUsers() {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>();
  return row?.n ?? 0;
}

describe("Better Auth configuration", () => {
  it("rejects public sign-up and creates no user", async () => {
    const before = await countUsers();
    const response = await post("/sign-up/email", {
      email: "intruder@example.com",
      password: "correct horse battery staple",
      name: "Intruder",
    });
    expect(response.ok).toBe(false);
    expect(await countUsers()).toBe(before);
  });

  it("rejects password sign-in", async () => {
    const response = await post("/sign-in/email", {
      email: "intruder@example.com",
      password: "correct horse battery staple",
    });
    expect(response.ok).toBe(false);
  });

  it("serves no /admin/impersonate-user", async () => {
    const response = await post("/admin/impersonate-user", { userId: "anyone" });
    expect(response.status).toBe(404);
  });

  it("serves no /admin/set-user-password", async () => {
    const response = await post("/admin/set-user-password", {
      userId: "anyone",
      newPassword: "correct horse battery staple",
    });
    expect(response.status).toBe(404);
  });

  it("keeps both disabled paths closed for a signed-in admin", async () => {
    const context = await auth.$context;
    const { user: admin } = await auth.api.createUser({
      body: { email: "admin@example.com", name: "Admin", role: "admin" },
    });
    const session = await context.internalAdapter.createSession(admin.id, false);
    const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(
      await signCookieValue(session.token, context.secret),
    )}`;

    const impersonate = await post("/admin/impersonate-user", { userId: admin.id }, { cookie });
    const setPassword = await post(
      "/admin/set-user-password",
      { userId: admin.id, newPassword: "correct horse battery staple" },
      { cookie },
    );
    expect(impersonate.status).toBe(404);
    expect(setPassword.status).toBe(404);

    // Control: the cookie is a real admin session, so an enabled admin endpoint accepts it.
    const list = await auth.handler(
      new Request(`${baseURL}/api/auth/admin/list-users`, { headers: { cookie } }),
    );
    expect(list.status).toBe(200);
  });

  it("creates users through the admin API without a password", async () => {
    const created = await auth.api.createUser({
      body: { email: "client@example.com", name: "Client", role: "user" },
    });
    expect(created.user.email).toBe("client@example.com");
    const accounts = await env.DB.prepare('SELECT COUNT(*) AS n FROM "account" WHERE "userId" = ?')
      .bind(created.user.id)
      .first<{ n: number }>();
    expect(accounts?.n).toBe(0);
  });

  it("limits requests per cf-connecting-ip in D1", async () => {
    const ip = "203.0.113.7";
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await post(
        "/sign-in/email",
        { email: "a@example.com", password: "x" },
        { "cf-connecting-ip": ip },
      );
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
    const row = await env.DB.prepare('SELECT "key" FROM "rateLimit" WHERE "key" LIKE ?')
      .bind(`${ip}%`)
      .first();
    expect(row).not.toBeNull();
  });
});

// Better Auth signs the session cookie as `<value>.<base64 HMAC-SHA-256>`.
async function signCookieValue(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return `${value}.${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}
