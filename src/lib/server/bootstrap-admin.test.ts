import { expect, test } from "bun:test";
import { bootstrapActor, bootstrapAdminSql } from "./bootstrap-admin.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

test("creates the admin, their link and one audit row, without the token or email in the audit", () => {
  const { sqlite } = sqliteD1();
  const now = Date.now();
  sqlite.run(
    bootstrapAdminSql({
      userId: "admin-1",
      email: "boss@example.com",
      tokenHash: "hash-1",
      expiresAt: now + 1000,
      now,
    }),
  );
  expect(sqlite.query(`SELECT role FROM "user" WHERE id = 'admin-1'`).get()).toEqual({
    role: "admin",
  });
  expect(sqlite.query(`SELECT COUNT(*) AS n FROM invitations`).get()).toEqual({ n: 1 });
  const row = sqlite.query(`SELECT * FROM audit_log`).all();
  expect(row).toHaveLength(1);
  expect(row[0]).toMatchObject({
    actor_id: bootstrapActor,
    action: "admin.create",
    target_user_id: "admin-1",
    after_json: '{"role":"admin"}',
  });
  expect(JSON.stringify(row)).not.toContain("boss@example.com");
  expect(JSON.stringify(row)).not.toContain("hash-1");
});
