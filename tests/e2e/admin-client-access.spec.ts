import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  count,
  d1,
  registerPasskey,
  seedPendingClient,
  seedSignedInUser,
  virtualAuthenticator,
} from "./support.ts";

test.beforeEach(async ({ context }) => {
  const ip = `10.5.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
});

const origin = "http://localhost:8790";
const actions = [
  "generateLink",
  "revokeLink",
  "deactivate",
  "reactivate",
  "revokeSession",
  "revokeAllSessions",
  "updateSettings",
  "recover",
];

// A client with a session, as the page lists it; `passkey` makes them an active client.
function seedClientSession(userId: string, { passkey = false } = {}) {
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  d1(
    `INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId","userAgent")
     VALUES ('${sessionId}','${new Date(Date.now() + 3_600_000).toISOString()}','${randomUUID()}','${now}','${now}','${userId}','Prueba/1.0')`,
  );
  if (passkey) {
    d1(
      `INSERT INTO "passkey" ("id","publicKey","userId","credentialID","counter","deviceType","backedUp")
       VALUES ('${randomUUID()}','k','${userId}','${randomUUID()}',0,'singleDevice',0)`,
    );
  }
  return sessionId;
}
const audited = (action: string, userId: string) =>
  count(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = '${action}' AND target_user_id = '${userId}'`,
  );

test("keeps the client page closed to clients and to anyone not signed in", async ({
  context,
  page,
}) => {
  const client = await seedPendingClient();
  const sessionId = seedClientSession(client.userId, { passkey: true });
  const url = `/admin/clientes/${client.userId}`;
  const post = (action: string) =>
    page.request.post(`${url}?/${action}`, { form: {}, headers: { origin } });

  expect((await page.request.get(url)).status()).toBe(401);
  for (const action of actions) expect((await post(action)).status()).toBe(401);

  await seedSignedInUser(context, { role: "user" });
  expect((await page.request.get(url)).status()).toBe(403);
  for (const action of actions) expect((await post(action)).status()).toBe(403);

  expect(count(`SELECT COUNT(*) AS n FROM "session" WHERE id = '${sessionId}'`)).toBe(1);
  expect(count(`SELECT banned AS n FROM "user" WHERE id = '${client.userId}'`)).toBe(0);
  expect(audited("client.deactivate", client.userId)).toBe(0);
});

test("answers 404 for an unknown id and for an admin, and links each client from /admin", async ({
  context,
  page,
}) => {
  const adminId = await seedSignedInUser(context, { role: "admin" });
  expect((await page.request.get(`/admin/clientes/${randomUUID()}`)).status()).toBe(404);
  expect((await page.request.get(`/admin/clientes/${adminId}`)).status()).toBe(404);
  expect((await page.request.get(`/admin/clientes/${encodeURIComponent("a b")}`)).status()).toBe(
    400,
  );

  const client = await seedPendingClient();
  await page.goto("/admin");
  await page.getByRole("link", { name: `${client.userId}@example.com` }).click();
  await expect(page).toHaveURL(`/admin/clientes/${client.userId}`);
  await expect(
    page.getByRole("heading", { name: `${client.userId}@example.com`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Configuración" })).toBeVisible();
});

test("deactivates and reactivates a client, ending their sessions and auditing both", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context, { role: "admin" });
  const client = await seedPendingClient();
  seedClientSession(client.userId, { passkey: true });
  seedClientSession(client.userId);
  await page.goto(`/admin/clientes/${client.userId}`);
  await expect(page.getByRole("row", { name: /Completa/ })).toHaveCount(2);

  await page.getByRole("button", { name: "Desactivar cliente" }).click();
  await expect(page.getByText(/Cliente desactivado/)).toBeVisible();
  await expect(page.getByText("No hay sesiones abiertas.")).toBeVisible();
  expect(count(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = '${client.userId}'`)).toBe(0);
  expect(count(`SELECT banned AS n FROM "user" WHERE id = '${client.userId}'`)).toBe(1);
  expect(audited("client.deactivate", client.userId)).toBe(1);

  await page.goto("/admin");
  await expect(
    page.getByRole("row", { name: new RegExp(`${client.userId}@example.com Desactivado`) }),
  ).toBeVisible();
  await page.goto(`/admin/clientes/${client.userId}`);
  await page.getByRole("button", { name: "Reactivar cliente" }).click();
  await expect(page.getByText("Cliente reactivado.")).toBeVisible();
  expect(count(`SELECT banned AS n FROM "user" WHERE id = '${client.userId}'`)).toBe(0);
  expect(audited("client.reactivate", client.userId)).toBe(1);
});

test("revokes one session and then the rest", async ({ context, page }) => {
  await seedSignedInUser(context, { role: "admin" });
  const client = await seedPendingClient();
  seedClientSession(client.userId, { passkey: true });
  seedClientSession(client.userId);
  seedClientSession(client.userId);
  await page.goto(`/admin/clientes/${client.userId}`);

  await page.getByRole("button", { name: "Cerrar sesión" }).first().click();
  await expect(page.getByText("Sesión cerrada.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Completa/ })).toHaveCount(2);
  expect(audited("session.revoke", client.userId)).toBe(1);

  await page.getByRole("button", { name: "Cerrar todas las sesiones" }).click();
  await expect(page.getByText("No hay sesiones abiertas.")).toBeVisible();
  expect(audited("session.revoke_all", client.userId)).toBe(1);
});

test("generates a new link shown once, invalidating the old one, then revokes it", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context, { role: "admin" });
  const client = await seedPendingClient();
  await page.goto(`/admin/clientes/${client.userId}`);
  await expect(page.getByText("Vigente", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Generar enlace nuevo" }).click();
  const link = await page.getByRole("textbox", { name: "Enlace de activación" }).inputValue();
  const token = link.split("/").pop() ?? "";
  expect(link).toMatch(new RegExp(`^${origin}/activar/[A-Za-z0-9_-]{20,}$`));
  expect(token).not.toBe(client.token);
  expect(JSON.stringify(d1("SELECT * FROM audit_log"))).not.toContain(token);
  expect(audited("activation_link.regenerate", client.userId)).toBe(1);

  const attempt = (value: string) =>
    page.request.post("/api/auth/activation/redeem", {
      data: { token: value },
      headers: { origin },
    });
  expect((await attempt(client.token)).status()).toBe(401);

  // Gone after a reload.
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Enlace de activación" })).toHaveCount(0);
  await page.getByRole("button", { name: "Revocar enlace" }).click();
  await expect(page.getByText("Enlace revocado.")).toBeVisible();
  await expect(page.getByText("Revocado", { exact: true })).toBeVisible();
  expect((await attempt(token)).status()).toBe(401);
  expect(audited("activation_link.revoke", client.userId)).toBe(1);
});

test("controlled recovery clears passkeys, codes and sessions and shows a new link once", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context, { role: "admin" });
  const client = await seedPendingClient();
  seedClientSession(client.userId, { passkey: true });
  d1(
    `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('${randomUUID()}','${client.userId}','h-${randomUUID()}')`,
  );
  await page.goto(`/admin/clientes/${client.userId}`);

  // The checkbox is required: the identity is verified outside the app.
  await page.getByRole("button", { name: "Iniciar recuperación" }).click();
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId" = '${client.userId}'`)).toBe(1);
  await page.getByLabel("Verifiqué la identidad del cliente fuera de la app").check();
  await page.getByRole("button", { name: "Iniciar recuperación" }).click();

  const link = await page.getByRole("textbox", { name: "Enlace de activación" }).inputValue();
  expect(link).toMatch(new RegExp(`^${origin}/activar/[A-Za-z0-9_-]{20,}$`));
  for (const table of [
    '"passkey" WHERE "userId"',
    '"session" WHERE "userId"',
    "recovery_codes WHERE user_id",
  ]) {
    expect(count(`SELECT COUNT(*) AS n FROM ${table} = '${client.userId}'`)).toBe(0);
  }
  expect(audited("client.recover", client.userId)).toBe(1);
  expect(JSON.stringify(d1("SELECT * FROM audit_log"))).not.toContain(link.split("/").pop() ?? "");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Enlace de activación" })).toHaveCount(0);

  // The admin never becomes the client: the new link opens the client's own activation screen.
  await context.clearCookies();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: /Activa/ })).toBeVisible();
});

test("asks a stale admin session to confirm with a passkey, then deactivates", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  await seedSignedInUser(context, { role: "admin", sessionAgeMs: 11 * 60_000 });
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  const client = await seedPendingClient();
  await page.goto(`/admin/clientes/${client.userId}`);

  await page.getByRole("button", { name: "Desactivar cliente" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "Confirma tu identidad con tu passkey",
  );
  expect(count(`SELECT banned AS n FROM "user" WHERE id = '${client.userId}'`)).toBe(0);

  await page.getByRole("button", { name: "Confirmar con passkey" }).click();
  await expect(page.getByText("Identidad confirmada")).toBeVisible();
  await page.getByRole("button", { name: "Desactivar cliente" }).click();
  await expect(page.getByText(/Cliente desactivado/)).toBeVisible();
  expect(audited("client.deactivate", client.userId)).toBe(1);
});

const settingsOf = (userId: string) =>
  d1(
    `SELECT size_usd AS sizeUsd, stop_pct AS stopPct, trailing_unlock_pct AS unlockPct FROM client_settings WHERE user_id = '${userId}'`,
  );

test("saves a client's settings with an audit row, refuses a lower SIZE and shows the limits read-only", async ({
  context,
  page,
}) => {
  await seedSignedInUser(context, { role: "admin" });
  const client = await seedPendingClient();
  const other = await seedPendingClient();
  await page.goto(`/admin/clientes/${client.userId}`);

  await expect(page.getByText("máx. 2", { exact: true })).toBeVisible();
  await expect(page.getByText("máx. 3", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Posiciones abiertas")).toHaveCount(0);

  await page.getByLabel("SIZE por entrada (USD)").fill("25000");
  await page.getByLabel("Stop inicial (%)").fill("25");
  await page.getByLabel("Desbloqueo del trailing (%)").fill("60");
  await page.getByRole("button", { name: "Guardar configuración" }).click();
  await expect(page.getByText("Configuración guardada.")).toBeVisible();
  expect(settingsOf(client.userId)).toEqual([{ sizeUsd: 25000, stopPct: 25, unlockPct: 60 }]);
  expect(settingsOf(other.userId)).toEqual([{ sizeUsd: 20000, stopPct: 30, unlockPct: 70 }]);
  expect(audited("client_settings.update", client.userId)).toBe(1);

  const post = (form: Record<string, string>) =>
    page.request.post(`/admin/clientes/${client.userId}?/updateSettings`, {
      form,
      headers: { origin, accept: "application/json" },
    });
  const lower = await post({ sizeUsd: "24999", stopPct: "25", unlockPct: "60" });
  expect(await lower.text()).toContain("SIZE solo puede aumentar.");
  const stop = await post({ sizeUsd: "25000", stopPct: "9", unlockPct: "60" });
  expect(await stop.text()).toContain("El stop debe ser un entero entre 10 y 50.");
  expect(settingsOf(client.userId)).toEqual([{ sizeUsd: 25000, stopPct: 25, unlockPct: 60 }]);
  expect(audited("client_settings.update", client.userId)).toBe(1);
});

test("the admin cannot impersonate a client or set their password", async ({ context, page }) => {
  await seedSignedInUser(context, { role: "admin" });
  const client = await seedPendingClient();
  const sessionsBefore = count(`SELECT COUNT(*) AS n FROM "session"`);
  for (const [path, data] of [
    ["/api/auth/admin/impersonate-user", { userId: client.userId }],
    ["/api/auth/admin/set-user-password", { userId: client.userId, newPassword: "x".repeat(12) }],
  ] as const) {
    const response = await page.request.post(path, { data, headers: { origin } });
    expect(response.status()).toBe(404);
  }
  expect(count(`SELECT COUNT(*) AS n FROM "session"`)).toBe(sessionsBefore);
  expect(count(`SELECT COUNT(*) AS n FROM "session" WHERE "impersonatedBy" IS NOT NULL`)).toBe(0);
});
