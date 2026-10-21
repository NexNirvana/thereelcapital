// Single-use recovery codes (docs/auth-and-security.md#flows). Only the HMAC of a code is stored
// (`hashToken`, purpose "recovery-code"); the plaintext exists once, in the response that shows
// it. Lookup is by hash, so no comparison of secrets happens in application code.
import { RECOVERY_CODE_COUNT } from "#lib/domain/config.ts";
import { auditStatement, type AuditDb } from "./audit.ts";
import { hashToken } from "./token-hash.ts";

// 31 symbols without 0/O/1/I/L, so a code copied from paper has no ambiguous character.
const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const codeLength = 25;
const groupSize = 5;
// Largest multiple of 31 below 256: bytes at or above it are redrawn, so every symbol is equally likely.
const unbiasedLimit = 248;

/** 25 symbols (about 124 bits) shown as five groups of five: `ABCDE-FGHJK-...`. */
export function newRecoveryCode(): string {
  const symbols: string[] = [];
  while (symbols.length < codeLength) {
    for (const byte of crypto.getRandomValues(new Uint8Array(codeLength))) {
      if (byte < unbiasedLimit && symbols.length < codeLength) {
        symbols.push(alphabet.charAt(byte % alphabet.length));
      }
    }
  }
  const groups: string[] = [];
  for (let start = 0; start < codeLength; start += groupSize) {
    groups.push(symbols.slice(start, start + groupSize).join(""));
  }
  return groups.join("-");
}

/** What the client typed, reduced to the stored form: no dashes or spaces, upper case. */
export function normalizeRecoveryCode(input: string): string {
  return input.replaceAll(/[\s-]/g, "").toUpperCase();
}

export interface RecoveryStatement {
  run(): Promise<{ meta: { changes: number } }>;
  first(): Promise<Record<string, unknown> | null>;
}
export interface RecoveryDb<S extends RecoveryStatement> extends AuditDb<S> {
  batch(statements: S[]): Promise<{ meta: { changes: number } }[]>;
}

const hashOf = (code: string, secret: string) =>
  hashToken("recovery-code", normalizeRecoveryCode(code), secret);

/**
 * Spends the matching unused code and returns its owner, or null when the code is wrong, already
 * used or belongs to a banned user. In the same batch, and only if this call spent the code, every
 * session and every passkey of the owner is deleted and two audit rows are written (the redemption
 * and the number of passkeys deleted, never their material): a lost or stolen passkey stops
 * working at once, with no window between spending the code and removing it. The owner's other
 * unused codes stay valid so an interrupted recovery can be retried with one of them
 * (docs/auth-and-security.md#flows). The UPDATE decides, so two concurrent redemptions of one
 * code cannot both succeed.
 */
export async function redeemRecoveryCode<S extends RecoveryStatement>(
  db: RecoveryDb<S>,
  code: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  const codeHash = await hashOf(code, secret);
  const notBanned = `user_id IN (SELECT "id" FROM "user" WHERE "banned" IS NOT 1)`;
  const owner = await db
    .prepare(
      `SELECT user_id FROM recovery_codes WHERE code_hash = ? AND used_at IS NULL AND ${notBanned}`,
    )
    .bind(codeHash)
    .first();
  if (typeof owner?.user_id !== "string") return null;
  const userId = owner.user_id;

  // Tied to this call, not to a timestamp: the audit row is written only when the UPDATE above it
  // in the batch changed a row (`changes()`), and the statements after it act only when that row
  // exists, so a concurrent loser (even within the same millisecond) deletes and audits nothing.
  const redemptionAuditId = crypto.randomUUID();
  const spentHere = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";
  const auditInsert = `INSERT INTO audit_log (id, at, actor_id, action, target_user_id, before_json, after_json)`;
  const redemptionAudit = db
    .prepare(`${auditInsert} SELECT ?, ?, ?, ?, ?, NULL, NULL WHERE changes() = 1`)
    .bind(redemptionAuditId, now, userId, "recovery.redeem", userId);
  const passkeysAudit = db
    .prepare(
      `${auditInsert} SELECT ?, ?, ?, ?, ?,
         json_object('count', (SELECT COUNT(*) FROM "passkey" WHERE "userId" = ?)),
         json_object('count', 0)
       WHERE ${spentHere}`,
    )
    .bind(
      crypto.randomUUID(),
      now,
      userId,
      "recovery.passkeys_delete",
      userId,
      userId,
      redemptionAuditId,
    );
  const [spent] = await db.batch([
    db
      .prepare(
        `UPDATE recovery_codes SET used_at = ?
         WHERE code_hash = ? AND used_at IS NULL AND ${notBanned}`,
      )
      .bind(now, codeHash),
    redemptionAudit,
    passkeysAudit,
    db
      .prepare(`DELETE FROM "passkey" WHERE "userId" = ? AND ${spentHere}`)
      .bind(userId, redemptionAuditId),
    db
      .prepare(`DELETE FROM "session" WHERE "userId" = ? AND ${spentHere}`)
      .bind(userId, redemptionAuditId),
  ]);
  return spent?.meta.changes === 1 ? userId : null;
}

/**
 * Undoes one redemption when nothing was granted for it (the audit write or the session failed),
 * so the client can retry with the same code. It only matches the code spent at exactly
 * `spentAt`, so it can never reopen a code that was used for a session.
 */
export async function releaseRecoveryCode<S extends RecoveryStatement>(
  db: RecoveryDb<S>,
  code: string,
  secret: string,
  spentAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE recovery_codes SET used_at = NULL WHERE code_hash = ? AND used_at = ?")
    .bind(await hashOf(code, secret), spentAt)
    .run();
}

/**
 * Replaces every code of the user (used or not) with a fresh set and writes the audit row in the
 * same batch. Returns the plaintext codes, which the caller shows once and never stores or logs.
 */
export async function replaceRecoveryCodes<S extends RecoveryStatement>(
  db: RecoveryDb<S>,
  secret: string,
  { actor, userId, action }: { actor: { user: { id: string } }; userId: string; action: string },
  now = Date.now(),
): Promise<string[]> {
  const unusedBefore = await db
    .prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .bind(userId)
    .first();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const inserts = await Promise.all(
    codes.map(async (code) =>
      db
        .prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), userId, await hashOf(code, secret)),
    ),
  );
  await db.batch([
    db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
    ...inserts,
    auditStatement(
      db,
      {
        actor,
        action,
        targetUserId: userId,
        before: { unusedCodes: typeof unusedBefore?.n === "number" ? unusedBefore.n : 0 },
        after: { unusedCodes: codes.length },
      },
      now,
    ),
  ]);
  return codes;
}
