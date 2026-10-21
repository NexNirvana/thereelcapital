import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  ACTIVATION_LINK_LIFETIME_MS,
  DEFAULT_SIZE_USD,
  DEFAULT_STOP_PCT,
  DEFAULT_TRAILING_UNLOCK_PCT,
} from "#lib/domain/config.ts";
import { activationUrl, newInvitation } from "./activation-link.ts";
import {
  claimInvitation,
  createClient,
  createUserWith,
  endOtherSessionsWhileOpen,
  isLinkOfToken,
  findOpenInvitation,
  regenerateActivationLink,
  revokeActivationLink,
} from "./activation.ts";
import { createAuth } from "./auth.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";
import { hashToken } from "./token-hash.ts";

const secret = crypto.randomUUID();

function migratedSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  return sqlite;
}
const admin = { user: { id: "admin-1" } };
const now = Date.parse("2026-10-21T15:00:00Z");

function dbWithClient(banned = false) {
  const db = sqliteD1();
  db.sqlite.run(
    `INSERT INTO "user" ("id","name","email","emailVerified","banned","createdAt","updatedAt")
     VALUES ('client-1','Cliente','c@example.com',0,?,0,0)`,
    [banned ? 1 : 0],
  );
  return db;
}

async function withLink(db = dbWithClient(), at = now) {
  const link = await newInvitation(secret, at);
  db.sqlite.run(
    `INSERT INTO invitations (id, user_id, token_hash, expires_at, created_by)
     VALUES ('inv-1','client-1',?,?,'admin-1')`,
    [link.tokenHash, link.expiresAt],
  );
  return { db, token: link.token };
}

function enrollmentSession(db: ReturnType<typeof sqliteD1>, token: string, invitationId = "inv-1") {
  db.sqlite.run(
    `INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId","enrollment","invitationId")
     VALUES (?,0,?,0,0,'client-1',1,?)`,
    [`s-${token}`, token, invitationId],
  );
}

const countOf = (db: ReturnType<typeof sqliteD1>, sql: string) =>
  db.sqlite.query<{ n: number }, []>(sql).get()?.n;

describe("activation link", () => {
  test("is 32 random bytes expiring after 72 hours, stored only as a domain-separated HMAC", async () => {
    const link = await newInvitation(secret, now);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt - now).toBe(72 * 3_600_000);
    expect(ACTIVATION_LINK_LIFETIME_MS).toBe(72 * 3_600_000);
    expect(link.tokenHash).toBe(await hashToken("activation-link", link.token, secret));
    expect(link.tokenHash).not.toBe(await hashToken("recovery-code", link.token, secret));
    expect(link.tokenHash).not.toContain(link.token);
  });

  test("builds the link from the origin only", () => {
    expect(activationUrl("https://thereelcapital.com/x?y", "abc")).toBe(
      "https://thereelcapital.com/activar/abc",
    );
  });
});

describe("findOpenInvitation", () => {
  test("finds an open link by its token", async () => {
    const { db, token } = await withLink();
    expect(await findOpenInvitation(db, token, secret, now)).toEqual({
      invitationId: "inv-1",
      userId: "client-1",
    });
  });

  test("rejects unknown, wrong-secret, expired, used, revoked and suspended-account links alike", async () => {
    const { db, token } = await withLink();
    expect(await findOpenInvitation(db, "x".repeat(43), secret, now)).toBeNull();
    expect(await findOpenInvitation(db, token, "other-secret", now)).toBeNull();
    expect(await findOpenInvitation(db, token, secret, now + 72 * 3_600_000)).toBeNull();

    db.sqlite.run("UPDATE invitations SET used_at = 1");
    expect(await findOpenInvitation(db, token, secret, now)).toBeNull();
    db.sqlite.run("UPDATE invitations SET used_at = NULL, revoked_at = 1");
    expect(await findOpenInvitation(db, token, secret, now)).toBeNull();
    db.sqlite.run("UPDATE invitations SET revoked_at = NULL");
    db.sqlite.run(`UPDATE "user" SET banned = 1`);
    expect(await findOpenInvitation(db, token, secret, now)).toBeNull();
  });

  test("a read never spends the link", async () => {
    const { db, token } = await withLink();
    await findOpenInvitation(db, token, secret, now);
    await findOpenInvitation(db, token, secret, now);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM invitations WHERE used_at IS NULL")).toBe(1);
  });
});

describe("claimInvitation", () => {
  const claim = (db: ReturnType<typeof sqliteD1>, at = now, sessionToken = "t1") =>
    claimInvitation(db, { invitationId: "inv-1", userId: "client-1", sessionToken }, at);

  test("spends the link once, ends the other sessions of the link and audits it", async () => {
    const { db } = await withLink();
    enrollmentSession(db, "t1");
    enrollmentSession(db, "t2");
    expect(await claim(db)).toBe(true);
    expect(await claim(db)).toBe(false);
    expect(db.sqlite.query(`SELECT token FROM "session"`).all()).toEqual([{ token: "t1" }]);
    expect(db.sqlite.query("SELECT actor_id, action, target_user_id FROM audit_log").all()).toEqual(
      [{ actor_id: "client-1", action: "activation.complete", target_user_id: "client-1" }],
    );
  });

  test("concurrent registrations on one link succeed exactly once", async () => {
    const { db } = await withLink();
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(db)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("refuses an expired, revoked, regenerated or suspended-account link", async () => {
    for (const mutate of [
      (db: ReturnType<typeof sqliteD1>) => db.sqlite.run("UPDATE invitations SET expires_at = 1"),
      (db: ReturnType<typeof sqliteD1>) => db.sqlite.run("UPDATE invitations SET revoked_at = 1"),
      (db: ReturnType<typeof sqliteD1>) => db.sqlite.run(`UPDATE "user" SET banned = 1`),
    ]) {
      const { db } = await withLink();
      mutate(db);
      expect(await claim(db)).toBe(false);
      expect(countOf(db, "SELECT COUNT(*) AS n FROM audit_log")).toBe(0);
    }
    const { db } = await withLink();
    await regenerateActivationLink(db, secret, admin, "client-1", now + 1);
    expect(await claim(db, now + 2)).toBe(false);
  });

  test("another user's link cannot be claimed for this user", async () => {
    const { db } = await withLink();
    expect(
      await claimInvitation(
        db,
        { invitationId: "inv-1", userId: "someone-else", sessionToken: "t" },
        now,
      ),
    ).toBe(false);
  });
});

describe("ending other sessions", () => {
  const end = (db: ReturnType<typeof sqliteD1>, at = now) =>
    endOtherSessionsWhileOpen(
      db,
      { invitationId: "inv-1", userId: "client-1", keepToken: "new" },
      at,
    );

  test("signs the client out of other sessions while the link is open", async () => {
    const { db } = await withLink();
    enrollmentSession(db, "old");
    enrollmentSession(db, "new");
    expect(await end(db)).toBe(true);
    expect(db.sqlite.query(`SELECT token FROM "session"`).all()).toEqual([{ token: "new" }]);
  });

  test("leaves the full session of a client who finished meanwhile", async () => {
    const { db } = await withLink();
    db.sqlite.run(
      `INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId","enrollment")
       VALUES ('s-full',0,'full',0,0,'client-1',0)`,
    );
    db.sqlite.run("UPDATE invitations SET used_at = 1");
    expect(await end(db)).toBe(false);
    expect(db.sqlite.query(`SELECT token FROM "session"`).all()).toEqual([{ token: "full" }]);
  });

  test("does nothing for an expired or revoked link", async () => {
    for (const closed of ["expires_at = 1", "revoked_at = 1"]) {
      const { db } = await withLink();
      enrollmentSession(db, "old");
      db.sqlite.run(`UPDATE invitations SET ${closed}`);
      expect(await end(db)).toBe(false);
      expect(countOf(db, `SELECT COUNT(*) AS n FROM "session"`)).toBe(1);
    }
  });
});

describe("isLinkOfToken", () => {
  test("is true only for the link the token belongs to", async () => {
    const { db, token } = await withLink();
    expect(await isLinkOfToken(db, "inv-1", token, secret)).toBe(true);
    expect(await isLinkOfToken(db, "inv-1", "x".repeat(43), secret)).toBe(false);
    expect(await isLinkOfToken(db, "inv-2", token, secret)).toBe(false);
  });
});

describe("revoking and regenerating", () => {
  test("regenerating replaces the open link, ends its sessions and audits without the token", async () => {
    const { db, token } = await withLink();
    enrollmentSession(db, "t1");
    const issued = await regenerateActivationLink(db, secret, admin, "client-1", now + 1000);

    expect(await findOpenInvitation(db, token, secret, now + 1000)).toBeNull();
    expect(await findOpenInvitation(db, issued.token, secret, now + 1000)).not.toBeNull();
    expect(countOf(db, `SELECT COUNT(*) AS n FROM "session"`)).toBe(0);
    expect(issued.expiresAt).toBe(now + 1000 + ACTIVATION_LINK_LIFETIME_MS);
    const rows = JSON.stringify(db.sqlite.query("SELECT * FROM audit_log").all());
    expect(rows).toContain("activation_link.regenerate");
    expect(rows).not.toContain(issued.token);
    expect(rows).not.toContain(token);
  });

  test("keeps the session that already spent its link", async () => {
    const { db } = await withLink();
    enrollmentSession(db, "t1");
    await claimInvitation(
      db,
      { invitationId: "inv-1", userId: "client-1", sessionToken: "t1" },
      now,
    );
    await regenerateActivationLink(db, secret, admin, "client-1", now + 1);
    expect(countOf(db, `SELECT COUNT(*) AS n FROM "session"`)).toBe(1);
  });

  test("revoking leaves no open link", async () => {
    const { db, token } = await withLink();
    enrollmentSession(db, "t1");
    await revokeActivationLink(db, admin, "client-1", now + 1);
    expect(await findOpenInvitation(db, token, secret, now + 1)).toBeNull();
    expect(countOf(db, `SELECT COUNT(*) AS n FROM "session"`)).toBe(0);
  });

  test("regenerating for an unknown user changes nothing", async () => {
    const { db } = await withLink();
    await expect(regenerateActivationLink(db, secret, admin, "ghost", now + 1)).rejects.toThrow();
    expect(countOf(db, "SELECT COUNT(*) AS n FROM invitations WHERE revoked_at IS NULL")).toBe(1);
  });
});

describe("createClient", () => {
  const insertUser = (db: ReturnType<typeof sqliteD1>) => async (email: string) => {
    db.sqlite.run(
      `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u1',?,?,0,0,0)`,
      [email, email],
    );
    return { id: "u1" };
  };

  test("creates the settings and a link with the configured defaults, and audits it", async () => {
    const db = sqliteD1();
    const issued = await createClient(
      { db, secret, createUser: insertUser(db) },
      admin,
      "nuevo@example.com",
      now,
    );
    expect(db.sqlite.query("SELECT * FROM client_settings").all()).toEqual([
      {
        user_id: "u1",
        size_usd: DEFAULT_SIZE_USD,
        stop_pct: DEFAULT_STOP_PCT,
        trailing_unlock_pct: DEFAULT_TRAILING_UNLOCK_PCT,
        updated_at: now,
      },
    ]);
    expect(DEFAULT_SIZE_USD).toBe(20_000);
    expect(DEFAULT_STOP_PCT).toBe(30);
    expect(DEFAULT_TRAILING_UNLOCK_PCT).toBe(70);
    expect(await findOpenInvitation(db, issued.token, secret, now)).toEqual({
      invitationId: expect.any(String),
      userId: "u1",
    });
    expect(db.sqlite.query("SELECT actor_id, action FROM audit_log").all()).toEqual([
      { actor_id: "admin-1", action: "client.create" },
    ]);
    expect(JSON.stringify(db.sqlite.query("SELECT * FROM audit_log").all())).not.toContain(
      issued.token,
    );
  });

  test("removes the user again when the rest fails, so the email can be reused", async () => {
    const db = sqliteD1();
    db.sqlite.run("DROP TABLE client_settings");
    await expect(
      createClient({ db, secret, createUser: insertUser(db) }, admin, "x@example.com", now),
    ).rejects.toThrow();
    expect(countOf(db, `SELECT COUNT(*) AS n FROM "user"`)).toBe(0);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM invitations")).toBe(0);
  });

  test("creates the user through Better Auth without a password, as a plain user", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const dir = new URL("../../../migrations/", import.meta.url);
    for (const file of readdirSync(dir).sort())
      sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
    const auth = createAuth({
      DB: sqlite,
      BETTER_AUTH_SECRET: secret,
      APP_ORIGIN: "http://localhost",
    });
    const { id } = await createUserWith(auth)("Nuevo@Example.com");
    expect(sqlite.prepare(`SELECT email, role FROM "user" WHERE id = ?`).get(id)).toEqual({
      email: "nuevo@example.com",
      role: "user",
    });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM "account"`).get()).toEqual({ n: 0 });
  });
});

describe("no email, no sign-up", () => {
  test("auth sends no email and offers no password or sign-up", () => {
    const auth = createAuth({
      DB: migratedSqlite(),
      BETTER_AUTH_SECRET: secret,
      APP_ORIGIN: "http://localhost",
    });
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
    expect(auth.options.plugins?.map((plugin) => plugin.id)).toEqual([
      "endpoint-policy",
      "admin",
      "passkey",
    ]);
    expect(auth.options.disabledPaths).toContain("/admin/set-user-password");
  });
});
