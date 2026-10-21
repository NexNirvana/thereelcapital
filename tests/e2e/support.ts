import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { type BrowserContext, type Page } from "@playwright/test";
import { newInvitation } from "../../src/lib/server/activation-link.ts";

// Same throwaway value playwright.config.ts passes to the dev server; not a credential.
export const authSecret = "e2e-only-secret-0123456789-0123456789";

// Test-only seeding straight into the local D1 the dev server uses. There is no sign-up or
// session-minting endpoint in the app, so a registered user needs a row and a signed cookie.
export function d1(sql: string): unknown[] {
  const output = execFileSync(
    "node_modules/.bin/wrangler",
    ["d1", "execute", "DB", "--local", "--json", "--command", sql],
    { encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(output);
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  return first && Array.isArray(first.results) ? first.results : [];
}

export function count(sql: string): number {
  const row = d1(sql)[0];
  return typeof row === "object" && row !== null && "n" in row && typeof row.n === "number"
    ? row.n
    : -1;
}

// A client the admin created and has not yet activated, with an activation link; `token` is what
// the admin would share. Rows are seeded straight into D1 because createClient has no public route.
export async function seedPendingClient({
  expiresInMs,
  banned = false,
}: { expiresInMs?: number; banned?: boolean } = {}) {
  const userId = randomUUID();
  const invitationId = randomUUID();
  const now = new Date().toISOString();
  const link = await newInvitation(authSecret);
  d1(
    `INSERT INTO "user" ("id","name","email","emailVerified","role","banned","createdAt","updatedAt")
     VALUES ('${userId}','Cliente','${userId}@example.com',0,'user',${banned ? 1 : 0},'${now}','${now}');
     INSERT INTO invitations ("id","user_id","token_hash","expires_at","created_by")
     VALUES ('${invitationId}','${userId}','${link.tokenHash}',${expiresInMs === undefined ? link.expiresAt : Date.now() + expiresInMs},'admin');`,
  );
  return { userId, invitationId, token: link.token };
}

export async function seedSignedInUser(context: BrowserContext) {
  const userId = randomUUID();
  const token = randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  d1(
    `INSERT INTO "user" ("id","name","email","emailVerified","role","createdAt","updatedAt")
     VALUES ('${userId}','Cliente','${userId}@example.com',0,'user','${now}','${now}');
     INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId")
     VALUES ('${randomUUID()}','${expires}','${token}','${now}','${now}','${userId}')`,
  );
  const signature = createHmac("sha256", authSecret).update(token).digest("base64");
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: encodeURIComponent(`${token}.${signature}`),
      url: "http://localhost:8790",
    },
  ]);
  return userId;
}

// An authenticator that cannot verify the user at all (no PIN or biometrics) is what produces
// UV=0 at registration: Chrome refuses to create a discoverable credential with a capable but
// unverified one.
export async function virtualAuthenticator(
  context: BrowserContext,
  page: Page,
  userVerified: boolean,
) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: userVerified,
      isUserVerified: userVerified,
      automaticPresenceSimulation: true,
    },
  });
  return {
    // The lost device: its credentials are gone, so registering again is a new passkey.
    forgetCredentials: () => cdp.send("WebAuthn.clearCredentials", { authenticatorId }),
    setUserVerified: (isUserVerified: boolean) =>
      cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified }),
  };
}

// Registers a passkey for the signed-in session. `requestUv: false` rewrites the server's options
// to "discouraged" so an unverified authenticator really produces UV=0 and the server's own check,
// not the browser, is what has to reject it.
export function registerPasskey(page: Page, requestUv: boolean) {
  return page.evaluate(async (requestUv) => {
    const options = await (await fetch("/api/auth/passkey/generate-register-options")).json();
    if (!requestUv) options.authenticatorSelection.userVerification = "discouraged";
    const credential = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
    });
    if (!(credential instanceof PublicKeyCredential)) throw new Error("no credential");
    const response = await fetch("/api/auth/passkey/verify-registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: credential.toJSON() }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, code: body?.code ?? null };
  }, requestUv);
}
