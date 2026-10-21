import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { count, seedSignedInUser } from "./support.ts";

const origin = "http://localhost:8790";

test.beforeEach(async ({ context }) => {
  const ip = `10.7.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
});

// Issue #104 item 1: Better Auth's own admin API answers any admin session with no fresh-session
// check and no audit row, so none of it is reachable over HTTP. The app calls it only in-process.
test("keeps every Better Auth admin endpoint closed, even to an admin session", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context, { role: "admin" });
  const rogue = `${randomUUID()}@example.com`;
  const calls: [string, string, object?][] = [
    ["POST", "/api/auth/admin/create-user", { email: rogue, name: "Rogue", role: "admin" }],
    ["POST", "/api/auth/admin/set-role", { userId: "x", role: "admin" }],
    ["POST", "/api/auth/admin/ban-user", { userId: "x" }],
    ["POST", "/api/auth/admin/unban-user", { userId: "x" }],
    ["POST", "/api/auth/admin/remove-user", { userId: "x" }],
    ["POST", "/api/auth/admin/revoke-user-sessions", { userId: "x" }],
    ["POST", "/api/auth/admin/update-user", { userId: "x", data: {} }],
    ["GET", "/api/auth/admin/list-users"],
    ["GET", "/api/auth/admin/get-user?id=x"],
    ["POST", "/api/auth/admin/some-future-endpoint", {}],
    // Core endpoints the app never calls are closed too.
    ["POST", "/api/auth/update-user", { name: "x" }],
    ["POST", "/api/auth/delete-user", {}],
  ];
  for (const [method, path, data] of calls) {
    const response = await page.request.fetch(path, { method, data, headers: { origin } });
    expect(response.status(), `${method} ${path}`).toBe(404);
  }
  expect(count(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = '${rogue}'`)).toBe(0);
});

test("keeps the endpoints the app uses reachable", async ({ page }) => {
  expect((await page.request.get("/api/auth/get-session")).status()).toBe(200);
});
