import { describe, expect, test } from "bun:test";
import { RECOVERY_CODE_COUNT } from "#lib/domain/config.ts";
import {
  newRecoveryCode,
  normalizeRecoveryCode,
  redeemRecoveryCode,
  releaseRecoveryCode,
  replaceRecoveryCodes,
} from "./recovery-codes.ts";
import { hashToken } from "./token-hash.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

const secret = crypto.randomUUID();
const actor = { user: { id: "user-1" } };

function dbWithUser(id = "user-1", banned = false) {
  const db = sqliteD1();
  db.sqlite.run(
    `INSERT INTO "user" ("id","name","email","emailVerified","banned","createdAt","updatedAt")
     VALUES (?, 'Cliente', ?, 0, ?, 0, 0)`,
    [id, `${id}@example.com`, banned ? 1 : 0],
  );
  return db;
}

describe("recovery code generation", () => {
  test("is 25 unambiguous symbols in five dashed groups", () => {
    for (let i = 0; i < 200; i++) {
      expect(newRecoveryCode()).toMatch(
        /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/,
      );
    }
  });

  test("never repeats", () => {
    expect(new Set(Array.from({ length: 1000 }, newRecoveryCode)).size).toBe(1000);
  });

  test("normalizes what a client types", () => {
    expect(normalizeRecoveryCode(" abcde-fghjk\n")).toBe("ABCDEFGHJK");
  });
});

describe("replaceRecoveryCodes", () => {
  test("stores only domain-separated hashes of ten codes and audits the change", async () => {
    const db = dbWithUser();
    const codes = await replaceRecoveryCodes(db, secret, {
      actor,
      userId: "user-1",
      action: "recovery_codes.regenerate",
    });
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);

    const stored = db.sqlite.query("SELECT code_hash FROM recovery_codes").all();
    expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
    const first = codes[0];
    if (first === undefined) throw new Error("no code");
    const hash = await hashToken("recovery-code", normalizeRecoveryCode(first), secret);
    expect(stored).toContainEqual({ code_hash: hash });
    expect(JSON.stringify(db.sqlite.query("SELECT * FROM recovery_codes").all())).not.toContain(
      first.replaceAll("-", ""),
    );

    const audits = db.sqlite.query("SELECT * FROM audit_log").all();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "recovery_codes.regenerate",
      actor_id: "user-1",
      target_user_id: "user-1",
      before_json: '{"unusedCodes":0}',
      after_json: `{"unusedCodes":${RECOVERY_CODE_COUNT}}`,
    });
    for (const code of codes) expect(JSON.stringify(audits)).not.toContain(code);
  });

  test("invalidates every earlier code, used or not", async () => {
    const db = dbWithUser();
    const options = { actor, userId: "user-1", action: "recovery_codes.regenerate" };
    const [old] = await replaceRecoveryCodes(db, secret, options);
    await replaceRecoveryCodes(db, secret, options);
    expect(await redeemRecoveryCode(db, old ?? "", secret)).toBeNull();
    expect(db.sqlite.query("SELECT COUNT(*) AS n FROM recovery_codes").get()).toEqual({
      n: RECOVERY_CODE_COUNT,
    });
  });

  test("writes nothing when the audit row fails", async () => {
    const db = dbWithUser();
    db.sqlite.run("DROP TABLE audit_log");
    await expect(
      replaceRecoveryCodes(db, secret, { actor, userId: "user-1", action: "x" }),
    ).rejects.toThrow();
    expect(db.sqlite.query("SELECT COUNT(*) AS n FROM recovery_codes").get()).toEqual({ n: 0 });
  });
});

describe("redeemRecoveryCode", () => {
  const options = { actor, userId: "user-1", action: "recovery_codes.regenerate" };

  test("returns the owner, accepting the code as typed", async () => {
    const db = dbWithUser();
    const [code] = await replaceRecoveryCodes(db, secret, options);
    expect(await redeemRecoveryCode(db, (code ?? "").toLowerCase(), secret)).toBe("user-1");
  });

  test("rejects a reused code", async () => {
    const db = dbWithUser();
    const [code] = await replaceRecoveryCodes(db, secret, options);
    expect(await redeemRecoveryCode(db, code ?? "", secret)).toBe("user-1");
    expect(await redeemRecoveryCode(db, code ?? "", secret)).toBeNull();
  });

  test("rejects a wrong code and leaves the codes untouched", async () => {
    const db = dbWithUser();
    await replaceRecoveryCodes(db, secret, options);
    expect(await redeemRecoveryCode(db, newRecoveryCode(), secret)).toBeNull();
    expect(
      db.sqlite.query("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL").get(),
    ).toEqual({
      n: RECOVERY_CODE_COUNT,
    });
  });

  test("rejects a code hashed under another secret or purpose", async () => {
    const db = dbWithUser();
    const [code] = await replaceRecoveryCodes(db, secret, options);
    expect(await redeemRecoveryCode(db, code ?? "", crypto.randomUUID())).toBeNull();
    db.sqlite.run("DELETE FROM recovery_codes");
    db.sqlite.run("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('c', 'user-1', ?)", [
      await hashToken("activation-link", normalizeRecoveryCode(code ?? ""), secret),
    ]);
    expect(await redeemRecoveryCode(db, code ?? "", secret)).toBeNull();
  });

  test("rejects the code of a banned user and keeps it unused", async () => {
    const db = dbWithUser("user-1", true);
    const [code] = await replaceRecoveryCodes(db, secret, options);
    expect(await redeemRecoveryCode(db, code ?? "", secret)).toBeNull();
    expect(
      db.sqlite.query("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL").get(),
    ).toEqual({
      n: RECOVERY_CODE_COUNT,
    });
  });

  test("concurrent redemption of one code succeeds exactly once", async () => {
    const db = dbWithUser();
    const [code] = await replaceRecoveryCodes(db, secret, options);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => redeemRecoveryCode(db, code ?? "", secret)),
    );
    expect(results.filter((owner) => owner === "user-1")).toHaveLength(1);
    expect(results.filter((owner) => owner === null)).toHaveLength(24);
  });

  test("a spent code can be released only by the redemption that spent it", async () => {
    const db = dbWithUser();
    const [code] = await replaceRecoveryCodes(db, secret, options);
    expect(await redeemRecoveryCode(db, code ?? "", secret, 1000)).toBe("user-1");
    // Another timestamp (a different redemption) cannot reopen it.
    await releaseRecoveryCode(db, code ?? "", secret, 999);
    expect(await redeemRecoveryCode(db, code ?? "", secret, 2000)).toBeNull();
    await releaseRecoveryCode(db, code ?? "", secret, 1000);
    expect(await redeemRecoveryCode(db, code ?? "", secret, 3000)).toBe("user-1");
  });
});
