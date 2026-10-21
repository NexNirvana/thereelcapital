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
  batch(statements: S[]): Promise<unknown>;
}

const hashOf = (code: string, secret: string) =>
  hashToken("recovery-code", normalizeRecoveryCode(code), secret);

/**
 * Atomically marks the matching unused code as used and returns its owner, or null when the code
 * is wrong, already used or belongs to a banned user. One statement decides, so two concurrent
 * redemptions of one code cannot both succeed.
 */
export async function redeemRecoveryCode<S extends RecoveryStatement>(
  db: RecoveryDb<S>,
  code: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE recovery_codes SET used_at = ?
       WHERE code_hash = ? AND used_at IS NULL
         AND user_id IN (SELECT "id" FROM "user" WHERE "banned" IS NOT 1)
       RETURNING user_id`,
    )
    .bind(now, await hashOf(code, secret))
    .first();
  return typeof row?.user_id === "string" ? row.user_id : null;
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
