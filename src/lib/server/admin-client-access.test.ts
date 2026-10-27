import { describe, expect, test } from "bun:test";
import { findOpenInvitation } from "./activation.ts";
import {
  accessErrors,
  deactivateClient,
  generateLink,
  getClientDetail,
  reactivateClient,
  getAdminSummary,
  listOtherAdmins,
  recoverAdmin,
  recoverClient,
  revokeAllSessions,
  revokeLink,
  nameErrors,
  renameClient,
  revokeSession,
  settingsErrors,
  updateClientSettings,
} from "./admin-client-access.ts";
import { guardErrors, type GuardLocals } from "./guards.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

const now = Date.parse("2026-10-21T15:00:00Z");
const day = 86_400_000;

const eventOf = (user: GuardLocals["user"], createdAt = new Date(now - 60_000)) => ({
  locals: { session: user ? { createdAt } : null, user } satisfies GuardLocals,
});
const admin = (createdAt?: Date) =>
  eventOf({ id: "admin-1", role: "admin", banned: false }, createdAt);

function setup() {
  const db = sqliteD1();
  const user = (id: string, role = "user", banned: number | null = null) =>
    db.sqlite.run(
      `INSERT INTO "user" ("id","name","email","emailVerified","role","banned","createdAt","updatedAt")
       VALUES (?,?,?,0,?,?,?,?)`,
      [id, id, `${id}@example.com`, role, banned, now, now],
    );
  user("admin-1", "admin");
  user("c1");
  user("c2");
  for (const id of ["c1", "c2"]) {
    db.sqlite.run(
      `INSERT INTO client_settings (user_id, size_usd, stop_pct, trailing_unlock_pct, updated_at)
       VALUES (?, 20000, 30, 70, ?)`,
      [id, now - day],
    );
  }
  const session = (id: string, userId: string, invitationId: string | null = null) =>
    db.sqlite.run(
      `INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId","invitationId")
       VALUES (?,?,?,?,?,?,?)`,
      [id, now + day, `tok-${id}`, now - 1000, now, userId, invitationId],
    );
  const passkey = (userId: string) =>
    db.sqlite.run(
      `INSERT INTO "passkey" ("id","publicKey","userId","credentialID","counter","deviceType","backedUp")
       VALUES (?,'k',?,?,0,'singleDevice',0)`,
      [`pk-${userId}`, userId, `cred-${userId}`],
    );
  const codes = (userId: string) => {
    for (const n of [1, 2]) {
      db.sqlite.run(`INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?,?,?)`, [
        `rc-${userId}-${n}`,
        userId,
        `hash-${userId}-${n}`,
      ]);
    }
  };
  return { db, ctx: { db }, user, session, passkey, codes };
}

const n = (db: ReturnType<typeof sqliteD1>, sql: string) =>
  db.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${sql}`).get()?.n;
const audits = (db: ReturnType<typeof sqliteD1>, action: string) =>
  db.sqlite
    .query<
      { actor_id: string; target_user_id: string; before_json: string; after_json: string },
      [string]
    >(`SELECT * FROM audit_log WHERE action = ?`)
    .all(action);

type Mutation = (
  s: ReturnType<typeof setup>,
  event: ReturnType<typeof admin>,
  id?: string,
) => Promise<unknown>;
const mutations: Record<string, Mutation> = {
  generateLink: (s, e, id = "c1") => generateLink(e, s.ctx, id, now),
  revokeLink: (s, e, id = "c1") => revokeLink(e, s.ctx, id, now),
  deactivate: (s, e, id = "c1") => deactivateClient(e, s.ctx, id, now),
  reactivate: (s, e, id = "c1") => reactivateClient(e, s.ctx, id, now),
  revokeSession: (s, e, id = "c1") => revokeSession(e, s.ctx, id, { sessionId: "s1" }, now),
  revokeAll: (s, e, id = "c1") => revokeAllSessions(e, s.ctx, id, now),
  updateSettings: (s, e, id = "c1") =>
    updateClientSettings(e, s.ctx, id, { sizeUsd: "25000", stopPct: "30", unlockPct: "70" }, now),
  rename: (s, e, id = "c1") => renameClient(e, s.ctx, id, { name: "Ana Pérez" }, now),
  recover: (s, e, id = "c1") => recoverClient(e, s.ctx, id, { verified: "on" }, now),
};

describe.each(Object.entries(mutations))("%s", (_name, run) => {
  test("answers 401 without a session and 403 to a client or a banned admin", async () => {
    const s = setup();
    await expect(run(s, eventOf(null))).rejects.toMatchObject({ status: 401 });
    await expect(run(s, eventOf({ id: "c2", role: "user" }))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      run(s, eventOf({ id: "admin-1", role: "admin", banned: true })),
    ).rejects.toMatchObject({ status: 403 });
    expect(n(s.db, "audit_log")).toBe(0);
  });

  test("asks a stale admin session to confirm with a passkey and changes nothing", async () => {
    const s = setup();
    s.session("s1", "c1");
    s.passkey("c1");
    s.codes("c1");
    const before = JSON.stringify(s.db.sqlite.query(`SELECT * FROM "user"`).all());
    const result = await run(s, admin(new Date(now - 11 * 60_000)));
    expect(result).toEqual({ ok: false, error: guardErrors.reauthRequired });
    expect(n(s.db, "audit_log")).toBe(0);
    expect(n(s.db, `"session"`)).toBe(1);
    expect(n(s.db, `"passkey"`)).toBe(1);
    expect(n(s.db, "recovery_codes")).toBe(2);
    expect(JSON.stringify(s.db.sqlite.query(`SELECT * FROM "user"`).all())).toBe(before);
  });

  test("treats an unknown id and an admin id as not found, and a malformed id as invalid", async () => {
    const s = setup();
    await expect(run(s, admin(), "nobody")).rejects.toMatchObject({ status: 404 });
    await expect(run(s, admin(), "admin-1")).rejects.toMatchObject({ status: 404 });
    await expect(run(s, admin(), "x' OR 1=1 --")).rejects.toMatchObject({ status: 400 });
    expect(n(s.db, "audit_log")).toBe(0);
  });
});

describe("getClientDetail", () => {
  test("shows profile, access, link state and unexpired sessions, without secrets", async () => {
    const s = setup();
    s.session("s1", "c1");
    s.db.sqlite.run(`UPDATE "session" SET "expiresAt" = ? WHERE "id" = 's1'`, [
      new Date(now + day).toISOString(),
    ]);
    s.db.sqlite.run(
      `INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","userId") VALUES ('old',?,?,?,?,'c1')`,
      [now - 1, "tok-old", now - day, now - day],
    );
    await generateLink(admin(), s.ctx, "c1", now);
    const detail = await getClientDetail(s.db, "c1", now);
    expect(detail).toMatchObject({
      id: "c1",
      email: "c1@example.com",
      role: "user",
      access: "invited",
      link: { state: "open", expiresAt: now + 72 * 3_600_000 },
    });
    expect(detail.sessions.map((session) => session.id)).toEqual(["s1"]);
    expect(JSON.stringify(detail)).not.toMatch(/tok-|token|hash/i);
    expect((await getClientDetail(s.db, "c1", now + 73 * 3_600_000)).link.state).toBe("expired");
  });
});

describe("activation link", () => {
  test("a new link replaces the old one and ends the enrollment sessions made from it", async () => {
    const s = setup();
    const first = await generateLink(admin(), s.ctx, "c1", now);
    if (!first.ok) throw new Error("expected a link");
    const open = await findOpenInvitation(s.db, first.issued.token, now);
    expect(open?.userId).toBe("c1");
    s.session("enroll", "c1", open?.invitationId);
    s.session("other", "c1");

    const second = await generateLink(admin(), s.ctx, "c1", now + 1000);
    if (!second.ok) throw new Error("expected a link");
    expect(await findOpenInvitation(s.db, first.issued.token, now + 1000)).toBeNull();
    expect((await findOpenInvitation(s.db, second.issued.token, now + 1000))?.userId).toBe("c1");
    expect(n(s.db, `"session" WHERE id = 'enroll'`)).toBe(0);
    expect(n(s.db, `"session" WHERE id = 'other'`)).toBe(1);
    const rows = audits(s.db, "activation_link.regenerate");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.actor_id).toBe("admin-1");
    expect(JSON.stringify(s.db.sqlite.query("SELECT * FROM audit_log").all())).not.toContain(
      first.issued.token,
    );
  });

  test("is refused for a deactivated client and for one that already has a passkey", async () => {
    const s = setup();
    s.user("off", "user", 1);
    expect(await generateLink(admin(), s.ctx, "off", now)).toEqual({
      ok: false,
      error: accessErrors.clientDisabled,
    });
    s.passkey("c1");
    expect(await generateLink(admin(), s.ctx, "c1", now)).toEqual({
      ok: false,
      error: accessErrors.alreadyEnrolled,
    });
    expect(n(s.db, "invitations")).toBe(0);
  });

  test("revoking closes the link and its enrollment sessions, once", async () => {
    const s = setup();
    const issued = await generateLink(admin(), s.ctx, "c1", now);
    if (!issued.ok) throw new Error("expected a link");
    const open = await findOpenInvitation(s.db, issued.issued.token, now);
    s.session("enroll", "c1", open?.invitationId);

    expect(await revokeLink(admin(), s.ctx, "c1", now)).toEqual({ ok: true });
    expect(await findOpenInvitation(s.db, issued.issued.token, now)).toBeNull();
    expect(n(s.db, `"session"`)).toBe(0);
    expect((await getClientDetail(s.db, "c1", now)).link.state).toBe("revoked");
    expect(audits(s.db, "activation_link.revoke")).toHaveLength(1);
    expect(await revokeLink(admin(), s.ctx, "c1", now)).toEqual({
      ok: false,
      error: accessErrors.noOpenLink,
    });
    expect(audits(s.db, "activation_link.revoke")).toHaveLength(1);
  });
});

describe("deactivate and reactivate", () => {
  test("deactivating bans, ends every session, audits, and leaves everything else alone", async () => {
    const s = setup();
    s.session("s1", "c1");
    s.session("s2", "c1");
    s.session("s3", "c2");
    s.passkey("c1");
    s.db.sqlite.run(
      `INSERT INTO broker_connection (user_id, client_id, client_secret_enc, refresh_token_enc, key_id, status)
       VALUES ('c1','c','s','r','k','ok')`,
    );
    const connection = JSON.stringify(s.db.sqlite.query("SELECT * FROM broker_connection").all());

    expect(await deactivateClient(admin(), s.ctx, "c1", now)).toEqual({
      ok: true,
      sessionsEnded: 2,
    });
    expect(s.db.sqlite.query(`SELECT "banned" FROM "user" WHERE id = 'c1'`).get()).toEqual({
      banned: 1,
    });
    expect(n(s.db, `"session" WHERE "userId" = 'c1'`)).toBe(0);
    expect(n(s.db, `"session" WHERE "userId" = 'c2'`)).toBe(1);
    expect(n(s.db, `"passkey"`)).toBe(1);
    // The orders live in the client's Durable Object, which this code cannot reach; the D1 rows
    // that describe the broker link are untouched too.
    expect(JSON.stringify(s.db.sqlite.query("SELECT * FROM broker_connection").all())).toBe(
      connection,
    );
    const [row] = audits(s.db, "client.deactivate");
    expect(row).toMatchObject({ actor_id: "admin-1", target_user_id: "c1" });
    expect(JSON.parse(row?.after_json ?? "{}")).toEqual({ access: "disabled", sessionsEnded: 2 });
    expect((await getClientDetail(s.db, "c1", now)).access).toBe("disabled");

    expect(await deactivateClient(admin(), s.ctx, "c1", now)).toEqual({
      ok: false,
      error: accessErrors.alreadyDisabled,
    });
    expect(audits(s.db, "client.deactivate")).toHaveLength(1);
  });

  test("reactivating clears the ban, audits, and refuses a client that is not deactivated", async () => {
    const s = setup();
    expect(await reactivateClient(admin(), s.ctx, "c1", now)).toEqual({
      ok: false,
      error: accessErrors.notDisabled,
    });
    await deactivateClient(admin(), s.ctx, "c1", now);
    expect(await reactivateClient(admin(), s.ctx, "c1", now)).toEqual({ ok: true });
    expect(s.db.sqlite.query(`SELECT "banned" FROM "user" WHERE id = 'c1'`).get()).toEqual({
      banned: 0,
    });
    expect(audits(s.db, "client.reactivate")).toHaveLength(1);
    expect(n(s.db, "audit_log")).toBe(2);
  });
});

describe("sessions", () => {
  test("revokes one session of the target only", async () => {
    const s = setup();
    s.session("s1", "c1");
    s.session("s2", "c1");
    s.session("theirs", "c2");
    expect(await revokeSession(admin(), s.ctx, "c1", { sessionId: "s1" }, now)).toEqual({
      ok: true,
    });
    expect(n(s.db, `"session"`)).toBe(2);
    // Another client's session id through this client's page does nothing, and is not audited.
    expect(await revokeSession(admin(), s.ctx, "c1", { sessionId: "theirs" }, now)).toEqual({
      ok: false,
      error: accessErrors.sessionGone,
    });
    expect(n(s.db, `"session" WHERE id = 'theirs'`)).toBe(1);
    expect(audits(s.db, "session.revoke")).toHaveLength(1);
  });

  test("rejects unknown fields and a missing session id", async () => {
    const s = setup();
    await expect(
      revokeSession(admin(), s.ctx, "c1", { sessionId: "s1", userId: "c2" }, now),
    ).rejects.toMatchObject({ status: 400 });
    await expect(revokeSession(admin(), s.ctx, "c1", {}, now)).rejects.toMatchObject({
      status: 400,
    });
  });

  test("revokes all sessions and audits the count", async () => {
    const s = setup();
    expect(await revokeAllSessions(admin(), s.ctx, "c1", now)).toEqual({
      ok: false,
      error: accessErrors.noSessions,
    });
    s.session("s1", "c1");
    s.session("s2", "c1");
    s.session("theirs", "c2");
    expect(await revokeAllSessions(admin(), s.ctx, "c1", now)).toEqual({
      ok: true,
      sessionsEnded: 2,
    });
    expect(n(s.db, `"session"`)).toBe(1);
    expect(JSON.parse(audits(s.db, "session.revoke_all")[0]?.before_json ?? "{}")).toEqual({
      sessions: 2,
    });
  });
});

describe("controlled recovery", () => {
  test("deletes passkeys, codes and sessions, closes the old link and returns a new one once", async () => {
    const s = setup();
    s.passkey("c1");
    s.passkey("c2");
    s.codes("c1");
    s.codes("c2");
    s.session("s1", "c1");
    s.session("theirs", "c2");
    s.db.sqlite.run(
      `INSERT INTO invitations (id, user_id, token_hash, expires_at, created_by) VALUES ('old','c1','oldhash',?, 'admin-1')`,
      [now + day],
    );

    const result = await recoverClient(admin(), s.ctx, "c1", { verified: "on" }, now);
    if (!result.ok) throw new Error("expected recovery");
    expect(await findOpenInvitation(s.db, result.issued.token, now)).toMatchObject({
      userId: "c1",
    });
    expect(n(s.db, `invitations WHERE id = 'old' AND revoked_at IS NOT NULL`)).toBe(1);
    expect(n(s.db, `"passkey" WHERE "userId" = 'c1'`)).toBe(0);
    expect(n(s.db, "recovery_codes WHERE user_id = 'c1'")).toBe(0);
    expect(n(s.db, `"session" WHERE "userId" = 'c1'`)).toBe(0);
    // Nothing of another client changes.
    expect(n(s.db, `"passkey" WHERE "userId" = 'c2'`)).toBe(1);
    expect(n(s.db, "recovery_codes WHERE user_id = 'c2'")).toBe(2);
    expect(n(s.db, `"session" WHERE "userId" = 'c2'`)).toBe(1);

    const [row] = audits(s.db, "client.recover");
    expect(row).toMatchObject({ actor_id: "admin-1", target_user_id: "c1" });
    expect(JSON.parse(row?.before_json ?? "{}")).toEqual({
      passkeys: 1,
      unusedCodes: 2,
      sessions: 1,
    });
    expect(JSON.stringify(s.db.sqlite.query("SELECT * FROM audit_log").all())).not.toContain(
      result.issued.token,
    );
    const detail = await getClientDetail(s.db, "c1", now);
    expect(detail).toMatchObject({
      access: "invited",
      passkeys: 0,
      unusedCodes: 0,
      link: { state: "open" },
    });
  });

  test("needs the identity confirmation and refuses a deactivated client, changing nothing", async () => {
    const s = setup();
    s.passkey("c1");
    s.codes("c1");
    s.user("off", "user", 1);
    for (const form of [{}, { verified: "off" }, { verified: "on", extra: "1" }]) {
      expect(await recoverClient(admin(), s.ctx, "c1", form, now)).toEqual({
        ok: false,
        error: accessErrors.unconfirmed,
      });
    }
    expect(await recoverClient(admin(), s.ctx, "off", { verified: "on" }, now)).toEqual({
      ok: false,
      error: accessErrors.clientDisabled,
    });
    expect(n(s.db, `"passkey"`)).toBe(1);
    expect(n(s.db, "recovery_codes")).toBe(2);
    expect(n(s.db, "audit_log")).toBe(0);
    expect(n(s.db, "invitations")).toBe(0);
  });
});

describe("admin recovery (another admin)", () => {
  const recover = (s: ReturnType<typeof setup>, e: ReturnType<typeof admin>, id = "admin-2") =>
    recoverAdmin(e, s.ctx, id, { verified: "on" }, now);

  function withLockedOutAdmin() {
    const s = setup();
    s.user("admin-2", "admin");
    s.passkey("admin-2");
    s.codes("admin-2");
    s.session("s-admin-2", "admin-2");
    s.passkey("c1");
    s.codes("c1");
    return s;
  }

  test("deletes the other admin's credentials, issues a link once and audits with counts only", async () => {
    const s = withLockedOutAdmin();
    const result = await recover(s, admin());
    if (!result.ok) throw new Error("expected recovery");
    expect(await findOpenInvitation(s.db, result.issued.token, now)).toMatchObject({
      userId: "admin-2",
    });
    expect(n(s.db, `"passkey" WHERE "userId" = 'admin-2'`)).toBe(0);
    expect(n(s.db, "recovery_codes WHERE user_id = 'admin-2'")).toBe(0);
    expect(n(s.db, `"session" WHERE "userId" = 'admin-2'`)).toBe(0);
    // Clients and the actor are untouched.
    expect(n(s.db, `"passkey" WHERE "userId" = 'c1'`)).toBe(1);
    expect(n(s.db, "recovery_codes WHERE user_id = 'c1'")).toBe(2);
    const [row] = audits(s.db, "admin.recover");
    expect(row).toMatchObject({ actor_id: "admin-1", target_user_id: "admin-2" });
    expect(JSON.parse(row?.before_json ?? "{}")).toEqual({
      passkeys: 1,
      unusedCodes: 2,
      sessions: 1,
    });
    expect(audits(s.db, "client.recover")).toHaveLength(0);
    expect(JSON.stringify(s.db.sqlite.query("SELECT * FROM audit_log").all())).not.toContain(
      result.issued.token,
    );
  });

  test("refuses one's own account, a client, a disabled admin and a missing confirmation", async () => {
    const s = withLockedOutAdmin();
    s.user("off", "admin", 1);
    expect(await recover(s, admin(), "admin-1")).toEqual({
      ok: false,
      error: accessErrors.ownAccount,
    });
    await expect(recover(s, admin(), "c1")).rejects.toMatchObject({ status: 404 });
    expect(await recover(s, admin(), "off")).toEqual({
      ok: false,
      error: accessErrors.adminDisabled,
    });
    expect(await recoverAdmin(admin(), s.ctx, "admin-2", {}, now)).toEqual({
      ok: false,
      error: accessErrors.unconfirmed,
    });
    expect(n(s.db, `"passkey" WHERE "userId" = 'admin-2'`)).toBe(1);
    expect(n(s.db, "audit_log")).toBe(0);
  });

  test("needs a fresh admin session; clients, anonymous visitors and stale sessions change nothing", async () => {
    const s = withLockedOutAdmin();
    await expect(recover(s, eventOf(null))).rejects.toMatchObject({ status: 401 });
    await expect(recover(s, eventOf({ id: "c1", role: "user" }))).rejects.toMatchObject({
      status: 403,
    });
    expect(await recover(s, admin(new Date(now - 11 * 60_000)))).toEqual({
      ok: false,
      error: guardErrors.reauthRequired,
    });
    expect(n(s.db, `"passkey" WHERE "userId" = 'admin-2'`)).toBe(1);
    expect(n(s.db, "audit_log")).toBe(0);
  });

  test("client actions still treat an admin as not found, and the summary and list exclude clients and self", async () => {
    const s = withLockedOutAdmin();
    await expect(
      recoverClient(admin(), s.ctx, "admin-2", { verified: "on" }, now),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(await getAdminSummary(s.db, "admin-2")).toMatchObject({
      id: "admin-2",
      passkeys: 1,
      unusedCodes: 2,
    });
    await expect(getAdminSummary(s.db, "c1")).rejects.toMatchObject({ status: 404 });
    expect(await listOtherAdmins(s.db, "admin-1")).toEqual([
      { id: "admin-2", email: "admin-2@example.com" },
    ]);
  });
});

describe("renameClient", () => {
  const rename = (s: ReturnType<typeof setup>, name: string, id = "c1") =>
    renameClient(admin(), s.ctx, id, { name }, now);
  const nameOf = (s: ReturnType<typeof setup>, id: string) =>
    s.db.sqlite.query(`SELECT "name" AS name FROM "user" WHERE "id" = ?`).get(id);

  test("trims and saves the name with one audit row of the old and new name", async () => {
    const s = setup();
    expect(await rename(s, "  Ana Pérez  ")).toEqual({ ok: true });
    expect(nameOf(s, "c1")).toEqual({ name: "Ana Pérez" });
    expect(nameOf(s, "c2")).toEqual({ name: "c2" });
    const [row, ...rest] = audits(s.db, "client.rename");
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ actor_id: "admin-1", target_user_id: "c1", at: now });
    expect(JSON.parse(row?.before_json ?? "")).toEqual({ name: "c1" });
    expect(JSON.parse(row?.after_json ?? "")).toEqual({ name: "Ana Pérez" });
  });

  test("is a no-op without an audit row when the name does not change", async () => {
    const s = setup();
    expect(await rename(s, " c1 ")).toEqual({ ok: true });
    expect(n(s.db, "audit_log")).toBe(0);
  });

  test.each(["", "   ", "x".repeat(255), "x".repeat(5000), "Ana\nPérez"])(
    "rejects the name %j",
    async (name) => {
      const s = setup();
      expect(await rename(s, name)).toEqual({ ok: false, error: nameErrors.nameInvalid });
      expect(nameOf(s, "c1")).toEqual({ name: "c1" });
      expect(n(s.db, "audit_log")).toBe(0);
    },
  );

  test("fails instead of overwriting when the name changed after the check", async () => {
    const s = setup();
    const racing = {
      ...s.ctx,
      db: new Proxy(s.db, {
        get(target, key, receiver) {
          if (key !== "batch") return Reflect.get(target, key, receiver);
          return (statements: Parameters<typeof s.db.batch>[0]) => {
            s.db.sqlite.run(`UPDATE "user" SET "name" = 'Otro' WHERE "id" = 'c1'`);
            return target.batch(statements);
          };
        },
      }),
    };
    expect(await renameClient(admin(), racing, "c1", { name: "Ana" }, now)).toEqual({
      ok: false,
      error: nameErrors.nameChangedMeanwhile,
    });
    expect(nameOf(s, "c1")).toEqual({ name: "Otro" });
    expect(audits(s.db, "client.rename")).toEqual([]);
  });

  test("renames only the client the admin names", async () => {
    const s = setup();
    await rename(s, "Luis", "c2");
    expect(nameOf(s, "c1")).toEqual({ name: "c1" });
    expect(nameOf(s, "c2")).toEqual({ name: "Luis" });
  });

  test("rejects unknown fields as invalid input", async () => {
    const s = setup();
    await expect(
      renameClient(admin(), s.ctx, "c1", { name: "Ana", email: "x@example.com" }, now),
    ).rejects.toMatchObject({ status: 400 });
    expect(n(s.db, "audit_log")).toBe(0);
  });
});

describe("updateClientSettings", () => {
  const save = (
    s: ReturnType<typeof setup>,
    values: Partial<Record<"sizeUsd" | "stopPct" | "unlockPct" | "dailyEntries", string>>,
    id = "c1",
  ) =>
    updateClientSettings(
      admin(),
      s.ctx,
      id,
      { sizeUsd: "20000", stopPct: "30", unlockPct: "70", ...values },
      now,
    );
  const settingsOf = (s: ReturnType<typeof setup>, id: string) =>
    s.db.sqlite
      .query(
        `SELECT size_usd AS sizeUsd, stop_pct AS stopPct, trailing_unlock_pct AS unlockPct,
           max_daily_entries AS dailyEntries, updated_at AS updatedAt FROM client_settings WHERE user_id = ?`,
      )
      .get(id);

  test("raises SIZE and changes the percentages with one audit row of before and after", async () => {
    const s = setup();
    expect(await save(s, { sizeUsd: "30000", stopPct: "25", unlockPct: "60" })).toEqual({
      ok: true,
    });
    expect(settingsOf(s, "c1")).toEqual({
      sizeUsd: 30000,
      stopPct: 25,
      unlockPct: 60,
      dailyEntries: 3,
      updatedAt: now,
    });
    const [row, ...rest] = audits(s.db, "client_settings.update");
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ actor_id: "admin-1", target_user_id: "c1" });
    expect(JSON.parse(row?.before_json ?? "")).toEqual({
      sizeUsd: 20000,
      stopPct: 30,
      trailingUnlockPct: 70,
      maxDailyEntries: 3,
    });
    expect(JSON.parse(row?.after_json ?? "")).toEqual({
      sizeUsd: 30000,
      stopPct: 25,
      trailingUnlockPct: 60,
      maxDailyEntries: 3,
    });
  });

  test("never touches another client's settings", async () => {
    const s = setup();
    const other = settingsOf(s, "c2");
    await save(s, { sizeUsd: "30000", stopPct: "10", unlockPct: "90" });
    expect(settingsOf(s, "c2")).toEqual(other);
  });

  test("rejects a lower SIZE and keeps the stored values", async () => {
    const s = setup();
    const stored = settingsOf(s, "c1");
    expect(await save(s, { sizeUsd: "19999", stopPct: "40" })).toEqual({
      ok: false,
      error: settingsErrors.sizeDecrease,
    });
    expect(settingsOf(s, "c1")).toEqual(stored);
    expect(n(s.db, "audit_log")).toBe(0);
  });

  test("accepts a SIZE one dollar above the stored one and refuses one whose micro-dollars overflow", async () => {
    const s = setup();
    expect(await save(s, { sizeUsd: "20001" })).toEqual({ ok: true });
    const stored = settingsOf(s, "c1");
    expect(await save(s, { sizeUsd: "999999999999" })).toEqual({
      ok: false,
      error: settingsErrors.sizeInvalid,
    });
    expect(settingsOf(s, "c1")).toEqual(stored);
  });

  test("refuses a save instead of throwing when the stored SIZE is out of range", async () => {
    const s = setup();
    s.db.sqlite.run(`UPDATE client_settings SET size_usd = 999999999999 WHERE user_id = 'c1'`);
    expect(await save(s, { sizeUsd: "30000" })).toEqual({
      ok: false,
      error: settingsErrors.sizeInvalid,
    });
  });

  test("accepts the same SIZE when a percentage changes and rejects a save that changes nothing", async () => {
    const s = setup();
    expect(await save(s, { stopPct: "35" })).toEqual({ ok: true });
    expect(await save(s, { stopPct: "35" })).toEqual({
      ok: false,
      error: settingsErrors.unchanged,
    });
    expect(n(s.db, "audit_log")).toBe(1);
  });

  test.each([
    ["stopPct", "9", settingsErrors.stopOutOfBounds],
    ["stopPct", "51", settingsErrors.stopOutOfBounds],
    ["stopPct", "30.5", settingsErrors.stopOutOfBounds],
    ["stopPct", "", settingsErrors.stopOutOfBounds],
    ["unlockPct", "29", settingsErrors.unlockOutOfBounds],
    ["unlockPct", "91", settingsErrors.unlockOutOfBounds],
    ["unlockPct", "1e1", settingsErrors.unlockOutOfBounds],
    ["sizeUsd", "0", settingsErrors.sizeInvalid],
    ["sizeUsd", "-5", settingsErrors.sizeInvalid],
    ["sizeUsd", "25000.50", settingsErrors.sizeInvalid],
    ["sizeUsd", "abc", settingsErrors.sizeInvalid],
  ] as const)("rejects %s = %j with its Spanish message", async (field, value, error) => {
    const s = setup();
    const stored = settingsOf(s, "c1");
    expect(await save(s, { [field]: value })).toEqual({ ok: false, error });
    expect(error.message).toMatch(/[a-zñ]/);
    expect(settingsOf(s, "c1")).toEqual(stored);
    expect(n(s.db, "audit_log")).toBe(0);
  });

  test("changes the daily entries limit with its audit row, leaving the rest alone", async () => {
    const s = setup();
    expect(await save(s, { dailyEntries: "1000" })).toEqual({ ok: true });
    expect(settingsOf(s, "c1")).toMatchObject({ sizeUsd: 20000, dailyEntries: 1000 });
    const [row, ...rest] = audits(s.db, "client_settings.update");
    expect(rest).toEqual([]);
    expect(JSON.parse(row?.before_json ?? "")).toMatchObject({ maxDailyEntries: 3 });
    expect(JSON.parse(row?.after_json ?? "")).toMatchObject({ maxDailyEntries: 1000 });
  });

  test("can lower the daily entries limit again, unlike SIZE", async () => {
    const s = setup();
    await save(s, { dailyEntries: "50" });
    expect(await save(s, { dailyEntries: "2" })).toEqual({ ok: true });
    expect(settingsOf(s, "c1")).toMatchObject({ dailyEntries: 2 });
  });

  test("keeps the current daily entries limit when the form omits it", async () => {
    const s = setup();
    await save(s, { dailyEntries: "7" });
    expect(await save(s, { stopPct: "25" })).toEqual({ ok: true });
    expect(settingsOf(s, "c1")).toMatchObject({ stopPct: 25, dailyEntries: 7 });
  });

  test.each(["0", "1001", "-1", "2.5", "abc", "", "1e2"])(
    "rejects a daily entries limit of %j with its Spanish message",
    async (value) => {
      const s = setup();
      const stored = settingsOf(s, "c1");
      expect(await save(s, { dailyEntries: value })).toEqual({
        ok: false,
        error: settingsErrors.dailyEntriesOutOfBounds,
      });
      expect(settingsErrors.dailyEntriesOutOfBounds.message).toContain("entre 1 y 1000");
      expect(settingsOf(s, "c1")).toEqual(stored);
      expect(n(s.db, "audit_log")).toBe(0);
    },
  );

  test("accepts both ends of the bounds", async () => {
    const s = setup();
    expect(await save(s, { stopPct: "10", unlockPct: "30" })).toEqual({ ok: true });
    expect(await save(s, { stopPct: "50", unlockPct: "90" })).toEqual({ ok: true });
  });

  test("rejects unknown fields as invalid input", async () => {
    const s = setup();
    await expect(
      updateClientSettings(
        admin(),
        s.ctx,
        "c1",
        { sizeUsd: "20000", stopPct: "30", unlockPct: "70", clientId: "c2" },
        now,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("fails instead of overwriting when the stored values changed after the check", async () => {
    const s = setup();
    const racing = {
      ...s.ctx,
      db: new Proxy(s.db, {
        get(target, key, receiver) {
          if (key !== "batch") return Reflect.get(target, key, receiver);
          return (statements: Parameters<typeof s.db.batch>[0]) => {
            s.db.sqlite.run(`UPDATE client_settings SET size_usd = 50000 WHERE user_id = 'c1'`);
            return target.batch(statements);
          };
        },
      }),
    };
    expect(
      await updateClientSettings(
        admin(),
        racing,
        "c1",
        { sizeUsd: "25000", stopPct: "30", unlockPct: "70" },
        now,
      ),
    ).toEqual({ ok: false, error: settingsErrors.changedMeanwhile });
    expect(settingsOf(s, "c1")).toMatchObject({ sizeUsd: 50000 });
    expect(n(s.db, "audit_log")).toBe(0);
  });

  test("shows the settings and the fixed limits in the detail", async () => {
    const s = setup();
    expect(await getClientDetail(s.db, "c1", now)).toMatchObject({
      settings: { sizeUsd: 20000, stopPct: 30, trailingUnlockPct: 70, maxDailyEntries: 3 },
      minSizeUsd: 20000,
      limits: { openPositions: 2 },
      bounds: { dailyEntries: { min: 1, max: 1000 } },
    });
  });
});
