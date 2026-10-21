import { describe, expect, test } from "bun:test";
import { RECOVERY_CODE_COUNT } from "#lib/domain/config.ts";
import { regenerateRecoveryCodes } from "./recovery-regenerate.ts";
import { redeemRecoveryCode } from "./recovery-codes.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

const secret = crypto.randomUUID();

function setup() {
  const db = sqliteD1();
  db.sqlite.run(
    `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     VALUES ('user-1','A','a@example.com',0,0,0), ('user-2','B','b@example.com',0,0,0)`,
  );
  return db;
}
const eventFor = (ageMs: number | null) => ({
  locals: {
    session: ageMs === null ? null : { createdAt: new Date(Date.now() - ageMs) },
    user: ageMs === null ? null : { id: "user-1", role: "user", banned: false },
  },
});
async function codesOf(response: Response): Promise<string[]> {
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "codes" in body && Array.isArray(body.codes)) {
    return body.codes.filter((code): code is string => typeof code === "string");
  }
  throw new Error("no codes in the response");
}
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (thrown) {
    return thrown;
  }
  return null;
};

describe("regenerateRecoveryCodes", () => {
  test("replaces the session user's codes with a fresh set, once shown, and audits it", async () => {
    const db = setup();
    const response = await regenerateRecoveryCodes(eventFor(30_000), db, secret);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const codes = await codesOf(response);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(await redeemRecoveryCode(db, codes[0] ?? "", secret)).toBe("user-1");
    expect(
      db.sqlite
        .query(
          "SELECT action, actor_id, target_user_id FROM audit_log WHERE action LIKE 'recovery_codes.%'",
        )
        .all(),
    ).toEqual([
      { action: "recovery_codes.regenerate", actor_id: "user-1", target_user_id: "user-1" },
    ]);
  });

  test("leaves other users' codes alone", async () => {
    const db = setup();
    db.sqlite.run("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ('x','user-2','h')");
    await regenerateRecoveryCodes(eventFor(0), db, secret);
    expect(
      db.sqlite.query("SELECT id FROM recovery_codes WHERE user_id = 'user-2'").all(),
    ).toHaveLength(1);
  });

  test("requires re-authentication when the session is older than ten minutes", async () => {
    const db = setup();
    const thrown = await rejection(regenerateRecoveryCodes(eventFor(11 * 60_000), db, secret));
    expect(thrown).toMatchObject({ status: 401, body: { code: "REAUTH_REQUIRED" } });
    expect(db.sqlite.query("SELECT COUNT(*) AS n FROM recovery_codes").get()).toEqual({ n: 0 });
  });

  test("requires a session, which an enrollment-only session is not", async () => {
    const db = setup();
    const thrown = await rejection(regenerateRecoveryCodes(eventFor(null), db, secret));
    expect(thrown).toMatchObject({ status: 401, body: { code: "AUTH_REQUIRED" } });
  });
});
