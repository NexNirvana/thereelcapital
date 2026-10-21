import { expect, test } from "@playwright/test";
import {
  ageSessions,
  count,
  d1,
  registerPasskey,
  seedSignedInUser,
  virtualAuthenticator,
} from "./support.ts";

test.beforeEach(async ({ context }) => {
  const ip = `10.4.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
});

const origin = "http://localhost:8790";
const uniqueEmail = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const clientCount = () => count(`SELECT COUNT(*) AS n FROM "user" WHERE role = 'user'`);

test("keeps /admin closed to clients and to anyone not signed in", async ({ context, page }) => {
  const anonymous = await page.request.get("/admin", { maxRedirects: 0 });
  expect(anonymous.status()).toBe(303);
  // SvelteKit writes the redirect relative to the request path.
  expect(new URL(anonymous.headers().location ?? "", "http://localhost:8790/admin").pathname).toBe(
    "/acceso",
  );

  await seedSignedInUser(context, { role: "user" });
  expect((await page.request.get("/admin")).status()).toBe(403);
  const before = clientCount();
  const attempt = await page.request.post("/admin?/create", {
    form: { email: uniqueEmail("sneaky") },
    headers: { origin },
  });
  expect(attempt.status()).toBe(403);
  expect(clientCount()).toBe(before);
});

test("creates a client, shows its link once and audits it", async ({ context, page }) => {
  await seedSignedInUser(context, { role: "admin" });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Clientes", level: 1 })).toBeVisible();

  const email = uniqueEmail("nuevo");
  await page.getByLabel("Correo del cliente").fill(email);
  await page.getByRole("button", { name: /Crear cliente/ }).click();

  await expect(page.getByText(`Cliente creado: ${email}`)).toBeVisible();
  const link = await page.getByLabel("Enlace de activación").inputValue();
  expect(link).toMatch(new RegExp(`^${origin}/activar/[A-Za-z0-9_-]{20,}$`));
  await expect(
    page.getByRole("row", { name: new RegExp(`${email} Invitado Sin conectar`) }),
  ).toBeVisible();
  expect(
    count(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'client.create' AND target_user_id = (SELECT id FROM "user" WHERE email = '${email}')`,
    ),
  ).toBe(1);
  expect(JSON.stringify(d1("SELECT * FROM audit_log"))).not.toContain(link.split("/").pop() ?? "");

  // Gone after a reload, and the link opens the activation screen.
  await page.reload();
  await expect(page.getByLabel("Enlace de activación")).toHaveCount(0);
  await context.clearCookies();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: /Activa/ })).toBeVisible();
});

test("refuses a duplicate or invalid email with its own message", async ({ context, page }) => {
  await seedSignedInUser(context, { role: "admin" });
  await page.goto("/admin");
  const email = uniqueEmail("dup");
  await page.getByLabel("Correo del cliente").fill(email);
  await page.getByRole("button", { name: /Crear cliente/ }).click();
  await expect(page.getByText(`Cliente creado: ${email}`)).toBeVisible();

  await page.getByLabel("Correo del cliente").fill(email.toUpperCase());
  await page.getByRole("button", { name: /Crear cliente/ }).click();
  await expect(page.getByRole("alert")).toContainText("Ya existe un cliente con ese correo.");
  expect(count(`SELECT COUNT(*) AS n FROM "user" WHERE email = '${email}'`)).toBe(1);

  // The browser blocks a malformed address; the server rejects it as well.
  const invalid = await page.request.post("/admin?/create", {
    form: { email: "nope" },
    headers: { origin },
  });
  expect(await invalid.text()).toContain("INVALID_EMAIL");
});

test("asks the admin to confirm with a passkey when the session is stale, then creates", async ({
  context,
  page,
}) => {
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  const adminId = await seedSignedInUser(context, { role: "admin" });
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });
  ageSessions(adminId, 11 * 60_000);
  await page.goto("/admin");

  const before = clientCount();
  const email = uniqueEmail("stale");
  await page.getByLabel("Correo del cliente").fill(email);
  await page.getByRole("button", { name: /Crear cliente/ }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "Confirma tu identidad con tu passkey",
  );
  expect(clientCount()).toBe(before);

  await page.getByRole("button", { name: "Confirmar con passkey" }).click();
  await expect(page.getByText("Identidad confirmada")).toBeVisible();
  await page.getByLabel("Correo del cliente").fill(email);
  await page.getByRole("button", { name: /Crear cliente/ }).click();
  await expect(page.getByText(`Cliente creado: ${email}`)).toBeVisible();
});
