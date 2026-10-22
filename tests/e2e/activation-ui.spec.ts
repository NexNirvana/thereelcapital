import { expect, test } from "./test.ts";
import { count, d1, registerPasskey, seedPendingClient, virtualAuthenticator } from "./support.ts";

test.beforeEach(async ({ context }) => {
  const ip = `10.3.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
});

test("activates through the screen: link, passkey, codes, connection page", async ({
  context,
  page,
}) => {
  const { userId, invitationId, token } = await seedPendingClient();
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);

  await page.goto(`/activar/${token}`);
  await expect(page.getByRole("heading", { name: /Activa/ })).toBeVisible();
  await page.getByRole("button", { name: "Comenzar" }).click();
  await expect(page.getByRole("heading", { name: /Registra tu/ })).toBeVisible();

  // Reloading mid-activation resumes at the passkey step; other pages stay closed.
  await page.reload();
  await expect(page.getByRole("heading", { name: /Registra tu/ })).toBeVisible();
  await page.goto("/conexion");
  await expect(page).toHaveURL(/\/recuperacion$/);
  await page.goBack();

  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("heading", { name: /Guarda tus/ })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Códigos de recuperación" }).getByRole("listitem"),
  ).toHaveCount(10);
  expect(
    count(
      `SELECT COUNT(*) AS n FROM invitations WHERE id='${invitationId}' AND used_at IS NOT NULL`,
    ),
  ).toBe(1);

  await page.getByRole("button", { name: "Ya los guardé" }).click();
  await expect(page).toHaveURL(/\/conexion$/);
  await expect(page.getByRole("heading", { name: "Conexión" })).toBeVisible();
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId"='${userId}'`)).toBe(1);

  // The spent link now only explains that it no longer works.
  await page.context().clearCookies();
  await page.goto(`/activar/${token}`);
  await page.getByRole("button", { name: "Comenzar" }).click();
  await expect(page.getByRole("alert")).toContainText("Este enlace no es válido o ya venció");
});

test("keeps the token out of Referer headers, caches and the analytics beacon", async ({
  page,
}) => {
  const { token } = await seedPendingClient();
  const response = await page.request.get(`/activar/${token}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response.headers()["cache-control"]).toBe("no-store, no-transform");
  expect(await response.text()).not.toContain(token);
});

test("tells the client when the link was revoked after it was opened", async ({
  context,
  page,
}) => {
  const { invitationId, token } = await seedPendingClient();
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  await page.goto(`/activar/${token}`);
  await page.getByRole("button", { name: "Comenzar" }).click();
  d1(`UPDATE invitations SET revoked_at = ${Date.now()} WHERE id = '${invitationId}'`);
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("alert")).toContainText("Este enlace no es válido o ya venció");
  await expect(page.getByRole("button", { name: "Comenzar" })).toBeVisible();
});

test("opening another client's link does not resume the first one's session", async ({ page }) => {
  const first = await seedPendingClient();
  const second = await seedPendingClient();
  await page.goto(`/activar/${first.token}`);
  await page.getByRole("button", { name: "Comenzar" }).click();
  await expect(page.getByRole("button", { name: "Crear passkey" })).toBeVisible();

  await page.goto(`/activar/${second.token}`);
  await expect(page.getByRole("button", { name: "Comenzar" })).toBeVisible();
  await page.getByRole("button", { name: "Comenzar" }).click();
  await expect(page.getByRole("button", { name: "Crear passkey" })).toBeVisible();
  // The browser now holds the second client's session, so that is whose passkey gets registered.
  const current = await (await page.request.get("/api/auth/get-session")).json();
  expect(current.session.userId).toBe(second.userId);
  expect(current.session.invitationId).toBe(second.invitationId);
});

test("reloading after the passkey was saved finishes without registering a second one", async ({
  context,
  page,
}) => {
  const { userId, token } = await seedPendingClient();
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  await page.goto(`/activar/${token}`);
  await page.getByRole("button", { name: "Comenzar" }).click();
  await expect(page.getByRole("button", { name: "Crear passkey" })).toBeVisible();
  expect(await registerPasskey(page, true)).toEqual({ status: 200, code: null });

  await page.reload();
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("heading", { name: /Guarda tus/ })).toBeVisible();
  expect(count(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId"='${userId}'`)).toBe(1);
});

test("explains that an expired link needs a new one from the admin", async ({ page }) => {
  const { token } = await seedPendingClient({ expiresInMs: -1000 });
  await page.goto(`/activar/${token}`);
  await page.getByRole("button", { name: "Comenzar" }).click();
  await expect(page.getByRole("alert")).toContainText("Pide uno nuevo a tu administrador");
  await expect(page.getByRole("heading", { name: /Activa/ })).toBeVisible();
});

test("sends the client back to the first step when the enrollment session expires", async ({
  context,
  page,
}) => {
  const { userId, token } = await seedPendingClient();
  await page.goto("/acceso");
  await virtualAuthenticator(context, page, true);
  await page.goto(`/activar/${token}`);
  await page.getByRole("button", { name: "Comenzar" }).click();
  await expect(page.getByRole("button", { name: "Crear passkey" })).toBeVisible();
  d1(
    `UPDATE "session" SET "createdAt" = '${new Date(Date.now() - 20 * 60_000).toISOString()}' WHERE "userId" = '${userId}'`,
  );

  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("alert")).toContainText("Tu sesión de registro venció");
  // The same link still works: a new session, and now the passkey registers.
  await page.getByRole("button", { name: "Comenzar" }).click();
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByRole("heading", { name: /Guarda tus/ })).toBeVisible();
});

test("the conexion page is closed to signed-out visitors", async ({ page }) => {
  await page.goto("/conexion");
  await expect(page).toHaveURL(/\/acceso$/);
});
