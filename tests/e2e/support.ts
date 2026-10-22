import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHmac, randomUUID } from "node:crypto";
import { type BrowserContext, type Page } from "@playwright/test";
import { newInvitation } from "../../src/lib/server/activation-link.ts";

// Same throwaway value playwright.config.ts passes to the dev server; not a credential.
export const authSecret = "e2e-only-secret-0123456789-0123456789";

// Test-only seeding straight into the local D1 the dev server uses. There is no sign-up or
// session-minting endpoint in the app, so a registered user needs a row and a signed cookie.
export function d1(sql: string): unknown[] {
  // The dev server's Durable Objects keep reconciling open orders and read the same D1 file, so
  // the CLI can meet a brief SQLITE_BUSY lock; it is safe to run the statement again.
  for (let attempt = 1; ; attempt++) {
    try {
      return runD1(sql);
    } catch (error) {
      // execFileSync's message only names the command; the lock is reported on stderr.
      const output = `${String(error)} ${error instanceof Error && "stderr" in error ? String(error.stderr) : ""}`;
      if (attempt === 5 || !output.includes("SQLITE_BUSY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * attempt);
    }
  }
}

function runD1(sql: string): unknown[] {
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
  const link = await newInvitation();
  d1(
    `INSERT INTO "user" ("id","name","email","emailVerified","role","banned","createdAt","updatedAt")
     VALUES ('${userId}','Cliente','${userId}@example.com',0,'user',${banned ? 1 : 0},'${now}','${now}');
     INSERT INTO client_settings (user_id, size_usd, stop_pct, trailing_unlock_pct, updated_at)
     VALUES ('${userId}',20000,30,70,${Date.now()});
     INSERT INTO invitations ("id","user_id","token_hash","expires_at","created_by")
     VALUES ('${invitationId}','${userId}','${link.tokenHash}',${expiresInMs === undefined ? link.expiresAt : Date.now() + expiresInMs},'admin');`,
  );
  return { userId, invitationId, token: link.token };
}

// `sessionAgeMs` backdates the session, which is what the 10-minute freshness check measures.
export async function seedSignedInUser(
  context: BrowserContext,
  {
    role = "user",
    sessionAgeMs = 0,
    existingUserId,
  }: { role?: "user" | "admin"; sessionAgeMs?: number; existingUserId?: string } = {},
) {
  const userId = existingUserId ?? randomUUID();
  const token = randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  const sessionStart = new Date(Date.now() - sessionAgeMs).toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  d1(
    `${
      existingUserId
        ? ""
        : `INSERT INTO "user" ("id","name","email","emailVerified","role","createdAt","updatedAt")
     VALUES ('${userId}','Cliente','${userId}@example.com',0,'${role}','${now}','${now}');`
    }
     INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId")
     VALUES ('${randomUUID()}','${expires}','${token}','${sessionStart}','${now}','${userId}')`,
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

// Makes a session look `ageMs` old, for after a passkey was registered: registering needs a fresh one.
export function ageSessions(userId: string, ageMs: number) {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  d1(`UPDATE "session" SET "createdAt" = '${createdAt}' WHERE "userId" = '${userId}'`);
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

// The engine runs on a pinned clock (TEST_NOW in engine.env), so anything the engine compares with
// the time (a token expiry) must be written relative to this, not to the real clock.
export const ENGINE_NOW = Date.parse(
  /^TEST_NOW=(.+)$/m.exec(readFileSync("tests/e2e/engine.env", "utf8"))?.[1] ?? "",
);

const DO_DIR = ".wrangler/state/v3/do/reel-engine-ClientCoordinator";

// The engine keeps a client's SIM accounts in its Durable Object, which only a real connection
// fills in (it needs TradeStation). For the specs they are written straight into the object's
// SQLite file, once a request has created and migrated it. Test-only, like d1() above.
// The directory does not exist until the first Durable Object of a fresh checkout is created.
const engineFiles = () =>
  new Set(
    existsSync(DO_DIR)
      ? readdirSync(DO_DIR).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
      : [],
  );

function seedEngineAccounts(file: string, accountIds: readonly string[]) {
  const db = new DatabaseSync(`${DO_DIR}/${file}`);
  try {
    // The engine holds the file open: wait for its write lock instead of failing.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("DELETE FROM broker_accounts");
    const insert = db.prepare(
      "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', ?, 'Margin')",
    );
    for (const accountId of accountIds) insert.run(accountId);
  } finally {
    db.close();
  }
}

export interface SeededOrder {
  readonly id: string;
  readonly symbol: string;
  readonly state: string;
  readonly qty: number;
  readonly filledQty?: number;
  readonly avgFillPrice?: number | null;
  readonly account?: string;
  readonly kind?: string;
  readonly createdAt: number;
}

// Orders as the engine would have stored them. There is no order UI yet (#26), and the history
// screen only reads what the Durable Object holds, so rows are written the way accounts are.
function seedEngineOrders(file: string, orders: readonly SeededOrder[]) {
  const db = new DatabaseSync(`${DO_DIR}/${file}`);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const insert = db.prepare(
      `INSERT INTO intents (id, mode, kind, account_id, symbol, asset_type, trade_action, qty, state,
         filled_qty, avg_fill_price, order_confirm_id, created_at, updated_at)
       VALUES (?, 'SIM', ?, ?, ?, 'equity', 'BUY', ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const o of orders) {
      insert.run(
        o.id,
        o.kind ?? "entry",
        o.account ?? "SIM-1",
        o.symbol,
        o.qty,
        o.state,
        o.filledQty ?? 0,
        o.avgFillPrice ?? null,
        o.id,
        o.createdAt,
        o.createdAt,
      );
    }
    db.prepare(
      "INSERT INTO events (at, mode, level, type, message) VALUES (?, 'SIM', 'info', 'broker.connected', 'broker.connected')",
    ).run(orders[0]?.createdAt ?? 0);
  } finally {
    db.close();
  }
}

// A signed-in client with a CONNECTED TradeStation SIM connection, SIZE and stop % in D1, and
// `accounts` in its engine. The engine runs the local simulation (tests/e2e/engine.env).
export async function seedTradingClient(
  context: BrowserContext,
  page: Page,
  {
    accounts = ["SIM-1"],
    sizeUsd = 20_000,
    orders = [],
  }: { accounts?: readonly string[]; sizeUsd?: number; orders?: readonly SeededOrder[] } = {},
) {
  const userId = await seedSignedInUser(context);
  d1(
    `INSERT INTO client_settings (user_id, size_usd, stop_pct, trailing_unlock_pct, updated_at)
     VALUES ('${userId}', ${sizeUsd}, 30, 70, 0);
     INSERT INTO broker_connection (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
     VALUES ('${userId}', 'e2e-client', 'x', 'x', 'k', NULL, 'CONNECTED', 0);
     INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('${randomUUID()}', '${userId}', 'h-${randomUUID()}')`,
  );
  // Any shell page reaches the engine and creates this client's object; the one new file is it.
  const existing = engineFiles();
  await page.goto("/conexion");
  // The object's file can show up a moment after the response that created it.
  let created: string[] = [];
  for (let attempt = 0; attempt < 50 && created.length === 0; attempt++) {
    created = [...engineFiles()].filter((file) => !existing.has(file));
    if (created.length === 0) await new Promise((done) => setTimeout(done, 100));
  }
  if (created.length !== 1)
    throw new Error(`expected one new Durable Object, got ${created.length}`);
  seedEngineAccounts(created[0] as string, accounts);
  if (orders.length > 0) seedEngineOrders(created[0] as string, orders);
  return userId;
}
