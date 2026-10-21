import { describe, expect, it } from "bun:test";
import { audit, auditStatement } from "./audit";

function fakeDb(fail = false) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        calls.push({ sql, values });
        return {
          run: async () => {
            if (fail) throw new Error("D1 down");
          },
        };
      },
    }),
  };
  return { db, calls };
}

const entry = {
  actor: { user: { id: "admin-1" } },
  action: "client_settings.update",
  targetUserId: "client-1",
  before: { sizeUsd: 500 },
  after: { sizeUsd: 750 },
};

describe("audit", () => {
  it("binds every value as a parameter, never into the SQL", async () => {
    const { db, calls } = fakeDb();
    await audit(db, { ...entry, action: "x'); DROP TABLE audit_log;--" }, 1234);
    const [call] = calls;
    expect(call?.sql).not.toContain("DROP");
    expect(call?.values.slice(1)).toEqual([
      1234,
      "admin-1",
      "x'); DROP TABLE audit_log;--",
      "client-1",
      '{"sizeUsd":500}',
      '{"sizeUsd":750}',
    ]);
  });

  it("stores NULL for absent before/after and target", async () => {
    const { db, calls } = fakeDb();
    await audit(db, { ...entry, targetUserId: null, before: undefined, after: null });
    expect(calls[0]?.values.slice(4)).toEqual([null, null, null]);
  });

  it("refuses credential-named fields at any depth", () => {
    const { db } = fakeDb();
    for (const after of [
      { clientSecret: "abc" },
      { nested: [{ refresh_token: "abc" }] },
      { code_hash: "abc" },
      { pwd: "abc" },
      { otp: "123456" },
      { authorization: "Bearer abc" },
      { cookie: "abc" },
      { recoveryCode: "abc" },
    ]) {
      expect(() => auditStatement(db, { ...entry, after })).toThrow("audit_log must not contain");
    }
  });

  it("does not put the offending value in the error", () => {
    const { db } = fakeDb();
    let message = "";
    try {
      auditStatement(db, { ...entry, after: { password: "hunter2" } });
    } catch (thrown) {
      message = String(thrown);
    }
    expect(message).toContain("password");
    expect(message).not.toContain("hunter2");
  });

  it("propagates a write failure so the mutation cannot proceed", async () => {
    const { db } = fakeDb(true);
    await expect(audit(db, entry)).rejects.toThrow("D1 down");
  });
});
