import { describe, expect, test } from "bun:test";
import { bootstrapAdminSql } from "./bootstrap-admin.ts";
import { adminLookupSql, recoverActor, recoverAdminSql } from "./recover-admin.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

const now = 1_800_000_000_000;
const hash = "a".repeat(64);

function seeded() {
  const { sqlite } = sqliteD1();
  sqlite.run(
    bootstrapAdminSql({
      userId: "admin-1",
      email: "boss@example.com",
      tokenHash: "old",
      expiresAt: now + 1,
      now,
    }),
  );
  sqlite.run(
    `INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt)
     VALUES ('client-1', 'c', 'c@example.com', 0, 'user', 'x', 'x')`,
  );
  for (const userId of ["admin-1", "client-1"]) {
    sqlite.run(
      `INSERT INTO "session" (id, token, userId, expiresAt, createdAt, updatedAt) VALUES ('s-${userId}', 't-${userId}', '${userId}', ${now + 1000}, ${now}, ${now})`,
    );
    sqlite.run(
      `INSERT INTO "passkey" (id, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES ('p-${userId}', 'k', '${userId}', 'c-${userId}', 0, 'multiDevice', 1, ${now})`,
    );
    sqlite.run(
      `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('r-${userId}', '${userId}', 'h-${userId}')`,
    );
  }
  return sqlite;
}
const count = (sqlite: ReturnType<typeof seeded>, table: string, where = "1") =>
  (sqlite.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

describe("recoverAdminSql", () => {
  test("removes the admin's credentials, replaces the link and audits with counts only", () => {
    const sqlite = seeded();
    sqlite.run(
      recoverAdminSql({ email: "boss@example.com", tokenHash: hash, expiresAt: now + 5, now }),
    );
    expect(count(sqlite, `"passkey"`, `"userId" = 'admin-1'`)).toBe(0);
    expect(count(sqlite, `"session"`, `"userId" = 'admin-1'`)).toBe(0);
    expect(count(sqlite, "recovery_codes", "user_id = 'admin-1'")).toBe(0);
    expect(
      sqlite
        .query(
          `SELECT token_hash FROM invitations WHERE revoked_at IS NULL AND user_id = 'admin-1'`,
        )
        .all(),
    ).toEqual([{ token_hash: hash }]);
    expect(count(sqlite, "invitations", "revoked_at IS NOT NULL")).toBe(1);
    const [audit] = sqlite
      .query(`SELECT * FROM audit_log WHERE action = 'admin.recover'`)
      .all() as Record<string, string>[];
    expect(audit).toMatchObject({ actor_id: recoverActor, target_user_id: "admin-1" });
    expect(audit?.before_json).toBe('{"passkeys":1,"unusedCodes":1,"sessions":1}');
    expect(JSON.stringify(audit)).not.toContain(hash);
  });

  test("leaves clients and unknown emails untouched", () => {
    const sqlite = seeded();
    for (const email of ["c@example.com", "ghost@example.com"]) {
      sqlite.run(recoverAdminSql({ email, tokenHash: hash, expiresAt: now + 5, now }));
    }
    expect(count(sqlite, `"passkey"`)).toBe(2);
    expect(count(sqlite, `"session"`)).toBe(2);
    expect(count(sqlite, "recovery_codes")).toBe(2);
    expect(count(sqlite, "invitations")).toBe(1);
    expect(count(sqlite, "audit_log", "action = 'admin.recover'")).toBe(0);
  });

  test("lookup finds only admins", () => {
    const sqlite = seeded();
    expect(sqlite.query(adminLookupSql("boss@example.com")).all()).toHaveLength(1);
    expect(sqlite.query(adminLookupSql("c@example.com")).all()).toHaveLength(0);
  });

  test("refuses values that could break out of the SQL literal", () => {
    const base = { tokenHash: hash, expiresAt: now, now };
    expect(() => recoverAdminSql({ ...base, email: "a'; DROP TABLE x;--@e.com" })).toThrow();
    expect(() => adminLookupSql("a'b@example.com")).toThrow();
    expect(() => recoverAdminSql({ ...base, email: "a@example.com", tokenHash: "x'--" })).toThrow();
  });
});
