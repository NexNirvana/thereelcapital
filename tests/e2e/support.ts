import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { type BrowserContext, type Page } from "@playwright/test";
import { sessionDate } from "../../src/lib/domain/calendar.ts";
import { newInvitation } from "../../src/lib/server/activation-link.ts";
import { origin } from "./ports.ts";

export { origin };

// Same throwaway value playwright.config.ts passes to the dev server; not a credential.
export const authSecret = "e2e-only-secret-0123456789-0123456789";

// Rows are seeded through the running app (/api/test/seed, open only when ENVIRONMENT is "test"),
// so the app is the only writer of its databases: a second process opening the same SQLite files
// races their locks (SQLITE_BUSY).
const SEED_URL = `${origin}/api/test/seed`;

interface SeedReply {
  readonly status: number;
  readonly text: string;
}

// Blocks until the reply arrives, so d1() stays synchronous for the specs: the request is made on
// a worker thread and the caller sleeps on a shared flag until it is done.
function postSeedSync(body: unknown): SeedReply {
  const done = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `const { workerData: { url, body, done, port } } = require("node:worker_threads");
     fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })
       .then(async (response) => ({ status: response.status, text: await response.text() }))
       .catch((error) => ({ status: 0, text: String(error) }))
       .then((reply) => { port.postMessage(reply); Atomics.store(done, 0, 1); Atomics.notify(done, 0); });`,
    {
      eval: true,
      workerData: { url: SEED_URL, body: JSON.stringify(body), done, port: port2 },
      transferList: [port2],
    },
  );
  try {
    Atomics.wait(done, 0, 0, 30_000);
    const message = receiveMessageOnPort(port1)?.message as SeedReply | undefined;
    if (!message) throw new Error("the seed request timed out");
    return message;
  } finally {
    void worker.terminate();
    port1.close();
  }
}

function checkSeedReply(reply: SeedReply): unknown {
  if (reply.status !== 200) throw new Error(`seeding failed (${reply.status}): ${reply.text}`);
  return JSON.parse(reply.text);
}

// Runs the statements as one transaction and returns the rows of the last one. There is no
// sign-up or session-minting endpoint in the app, so a registered user needs rows and a signed cookie.
export function d1(sql: string): unknown[] {
  // The statements are the helpers' own literals, none holds a `;` followed by a line break.
  const statements = sql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  const reply = checkSeedReply(postSeedSync({ target: "d1", statements }));
  const results =
    typeof reply === "object" && reply !== null && "results" in reply ? reply.results : [];
  return Array.isArray(results) ? results : [];
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
      url: origin,
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

// The engine keeps a client's SIM accounts, orders and positions in its Durable Object, which only
// a real connection and real trading fill in (they need TradeStation). For the specs the rows are
// written from inside the object (see engine/src/test-seed.ts). Addressing the object by the
// client id creates and migrates it, as the app's own requests do.
interface EngineStatement {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number | null>;
}

async function seedEngine(clientId: string, statements: readonly EngineStatement[]) {
  const response = await fetch(SEED_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "engine", clientId, statements }),
  });
  if (!response.ok) throw new Error(`engine seeding failed (${response.status})`);
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
function orderStatements(orders: readonly SeededOrder[]): EngineStatement[] {
  return [
    ...orders.map((o) => ({
      sql: `INSERT INTO intents (id, mode, kind, account_id, symbol, asset_type, trade_action, qty, state,
         filled_qty, avg_fill_price, order_confirm_id, created_at, updated_at)
       VALUES (?, 'SIM', ?, ?, ?, 'equity', 'BUY', ?, ?, ?, ?, ?, ?, ?)`,
      params: [
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
      ],
    })),
    {
      sql: "INSERT INTO events (at, mode, level, type, message) VALUES (?, 'SIM', 'info', 'broker.connected', 'broker.connected')",
      params: [orders[0]?.createdAt ?? 0],
    },
  ];
}

export interface SeededPosition {
  readonly id: string;
  readonly symbol: string;
  readonly qty: number;
  readonly soldQty?: number;
  readonly protectionState?: string;
  readonly account?: string;
  /** An option position, as the engine stores it (strike in micro-dollars). */
  readonly option?: {
    readonly underlying: string;
    readonly expiry: string;
    readonly strike: number;
    readonly right: "call" | "put";
  };
  /** The seven step states; `available` for all when omitted. */
  readonly steps?: readonly string[];
}

// Open positions and the day's entry count as the engine would have stored them (no order UI yet).
function positionStatements(
  positions: readonly SeededPosition[],
  entries: number,
): EngineStatement[] {
  return [
    ...positions.map((p) => ({
      sql: `INSERT INTO positions (id, mode, account_id, symbol, original_qty, sold_qty, avg_entry_price, stop_pct,
         trailing_unlock_pct, protection_state, status, opened_on, underlying, expiry, strike, right)
       VALUES (?, 'SIM', ?, ?, ?, ?, 101000000, 30, 70, ?, 'OPEN', '2026-11-04', ?, ?, ?, ?)`,
      params: [
        p.id,
        p.account ?? "SIM-1",
        p.symbol,
        p.qty,
        p.soldQty ?? 0,
        p.protectionState ?? "none",
        p.option?.underlying ?? null,
        p.option?.expiry ?? null,
        p.option?.strike ?? null,
        p.option?.right ?? null,
      ],
    })),
    ...positions.flatMap((p) =>
      Array.from({ length: 7 }, (_, idx) => ({
        sql: "INSERT INTO scaleout_steps (position_id, mode, idx, state) VALUES (?, 'SIM', ?, ?)",
        params: [p.id, idx, p.steps?.[idx] ?? "available"],
      })),
    ),
    ...(entries > 0
      ? [
          {
            sql: "INSERT INTO entry_counters (mode, session_date, consumed, reserved) VALUES ('SIM', ?, ?, 0)",
            params: [sessionDate(new Date(ENGINE_NOW)), entries],
          },
        ]
      : []),
  ];
}

// A signed-in client with a CONNECTED TradeStation SIM connection, SIZE and stop % in D1, and
// `accounts` in its engine. The engine runs the local simulation (tests/e2e/engine.env).
export async function seedTradingClient(
  context: BrowserContext,
  {
    accounts = ["SIM-1"],
    sizeUsd = 20_000,
    orders = [],
    positions = [],
    entriesToday = 0,
    status = "CONNECTED",
    refreshExpiresAt = null,
  }: {
    accounts?: readonly string[];
    sizeUsd?: number;
    orders?: readonly SeededOrder[];
    positions?: readonly SeededPosition[];
    entriesToday?: number;
    status?: "CONNECTED" | "EXPIRED" | "REVOKED" | "ERROR";
    refreshExpiresAt?: number | null;
  } = {},
) {
  const userId = await seedSignedInUser(context);
  d1(
    `INSERT INTO client_settings (user_id, size_usd, stop_pct, trailing_unlock_pct, updated_at)
     VALUES ('${userId}', ${sizeUsd}, 30, 70, 0);
     INSERT INTO broker_connection (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, refresh_expires_at, status, last_ok_at)
     VALUES ('${userId}', 'e2e-client', 'x', 'x', 'k', ${refreshExpiresAt ?? "NULL"}, '${status}', ${ENGINE_NOW - 60_000});
     INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('${randomUUID()}', '${userId}', 'h-${randomUUID()}')`,
  );
  await seedEngine(userId, [
    { sql: "DELETE FROM broker_accounts", params: [] },
    ...accounts.map((accountId) => ({
      sql: "INSERT INTO broker_accounts (mode, account_id, account_type) VALUES ('SIM', ?, 'Margin')",
      params: [accountId],
    })),
    ...(orders.length > 0 ? orderStatements(orders) : []),
    ...(positions.length > 0 || entriesToday > 0
      ? positionStatements(positions, entriesToday)
      : []),
  ]);
  return userId;
}
