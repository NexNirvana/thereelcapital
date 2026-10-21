import { describe, expect, test } from "bun:test";
import { findOpenInvitation } from "./activation.ts";
import { clientErrors, createClientFromForm, listClients } from "./admin-clients.ts";
import { guardErrors, type GuardLocals } from "./guards.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

const secret = crypto.randomUUID();
const now = Date.parse("2026-10-21T15:00:00Z");
const origin = "https://thereelcapital.com";

const adminEvent = (createdAt = new Date(now - 60_000), role = "admin", banned = false) => ({
  locals: {
    session: { createdAt },
    user: { id: "admin-1", role, banned },
  } satisfies GuardLocals,
});

function setup() {
  const db = sqliteD1();
  const createUser = async (email: string) => {
    db.sqlite.run(
      `INSERT INTO "user" ("id","name","email","emailVerified","role","createdAt","updatedAt")
       VALUES ('u-' || ?, ?, ?, 0, 'user', ?, ?)`,
      [email, email, email, now, now],
    );
    return { id: `u-${email}` };
  };
  return { db, env: { db, secret, origin, createUser } };
}

const count = (db: ReturnType<typeof sqliteD1>, table: string) =>
  db.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;

describe("listClients", () => {
  test("derives access from the ban and the passkey, and the connection from its row", async () => {
    const { db } = setup();
    const user = (id: string, role: string, banned: number | null, at: number) =>
      db.sqlite.run(
        `INSERT INTO "user" ("id","name","email","emailVerified","role","banned","createdAt","updatedAt")
         VALUES (?,?,?,0,?,?,?,?)`,
        [id, id, `${id}@example.com`, role, banned, at, at],
      );
    user("invited", "user", null, 1);
    user("active", "user", 0, 2);
    user("banned-active", "user", 1, 3);
    user("boss", "admin", null, 4);
    for (const id of ["active", "banned-active"]) {
      db.sqlite.run(
        `INSERT INTO "passkey" ("id","publicKey","userId","credentialID","counter","deviceType","backedUp")
         VALUES (?,'k',?,?,0,'singleDevice',0)`,
        [`pk-${id}`, id, `cred-${id}`],
      );
    }
    db.sqlite.run(
      `INSERT INTO broker_connection (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, status)
       VALUES ('active','c','s','r','k','ok')`,
    );

    expect(await listClients(db)).toEqual([
      {
        id: "banned-active",
        email: "banned-active@example.com",
        access: "disabled",
        hasConnection: 0,
      },
      { id: "active", email: "active@example.com", access: "active", hasConnection: 1 },
      { id: "invited", email: "invited@example.com", access: "invited", hasConnection: 0 },
    ]);
  });

  test("is empty without clients", async () => {
    expect(await listClients(setup().db)).toEqual([]);
  });
});

describe("createClientFromForm", () => {
  test("creates the client, returns the link once and audits it with the session admin", async () => {
    const { db, env } = setup();
    const result = await createClientFromForm(
      adminEvent(),
      env,
      { email: "Nuevo@Example.com" },
      now,
    );
    if (!result.ok) throw new Error("expected success");
    expect(result.email).toBe("nuevo@example.com");
    const token = result.link.slice(`${origin}/activar/`.length);
    expect(result.link).toBe(`${origin}/activar/${token}`);
    expect(await findOpenInvitation(db, token, secret, now)).not.toBeNull();
    expect(db.sqlite.query("SELECT actor_id, action FROM audit_log").all()).toEqual([
      { actor_id: "admin-1", action: "client.create" },
    ]);
    // Neither the token nor the link is stored anywhere in the audit row.
    expect(JSON.stringify(db.sqlite.query("SELECT * FROM audit_log").all())).not.toContain(token);
  });

  test("rejects a client, a missing session and a banned admin before touching anything", async () => {
    const { db, env } = setup();
    const create = (event: Parameters<typeof createClientFromForm>[0]) =>
      createClientFromForm(event, env, { email: "a@example.com" }, now);
    await expect(create(adminEvent(undefined, "user"))).rejects.toMatchObject({ status: 403 });
    await expect(create(adminEvent(undefined, "admin", true))).rejects.toMatchObject({
      status: 403,
    });
    await expect(create({ locals: { session: null, user: null } })).rejects.toMatchObject({
      status: 401,
    });
    expect(count(db, '"user"')).toBe(0);
    expect(count(db, "audit_log")).toBe(0);
  });

  test("asks for a new passkey sign-in when the session is older than 10 minutes", async () => {
    const { db, env } = setup();
    const stale = adminEvent(new Date(now - 11 * 60_000));
    expect(await createClientFromForm(stale, env, { email: "a@example.com" }, now)).toEqual({
      ok: false,
      error: guardErrors.reauthRequired,
    });
    expect(count(db, '"user"')).toBe(0);
  });

  test("rejects an invalid email and unknown fields", async () => {
    const { db, env } = setup();
    for (const form of [
      { email: "not-an-email" },
      { email: "" },
      { email: "a@example.com", role: "admin" },
      {},
      null,
    ]) {
      expect(await createClientFromForm(adminEvent(), env, form, now)).toEqual({
        ok: false,
        error: clientErrors.invalidEmail,
      });
    }
    expect(count(db, '"user"')).toBe(0);
  });

  test("answers a duplicate email with its own code, whatever the letter case", async () => {
    const { db, env } = setup();
    await createClientFromForm(adminEvent(), env, { email: "dup@example.com" }, now);
    expect(
      await createClientFromForm(adminEvent(), env, { email: "DUP@example.com" }, now),
    ).toEqual({ ok: false, error: clientErrors.emailTaken });
    expect(count(db, "invitations")).toBe(1);
    expect(count(db, "audit_log")).toBe(1);
  });

  test("reports a failure with a stable code and leaves nothing behind", async () => {
    const { db, env } = setup();
    db.sqlite.run("DROP TABLE client_settings");
    expect(await createClientFromForm(adminEvent(), env, { email: "x@example.com" }, now)).toEqual({
      ok: false,
      error: clientErrors.createFailed,
    });
    expect(count(db, '"user"')).toBe(0);
  });
});
