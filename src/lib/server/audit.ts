// docs/auth-and-security.md#secrets: audit_log stores before/after of settings and roles, never
// credential values. The schema is migrations/0003_app_tables.sql.

// The slice of D1 used here; D1Database satisfies it and tests can fake it without casts.
export interface AuditDb<Statement extends { run(): Promise<unknown> }> {
  prepare(sql: string): { bind(...values: unknown[]): Statement };
}

export interface AuditEntry {
  /** The guard's result (`requireAdmin`), so the actor is the session user, never a request value. */
  actor: { user: { id: string } };
  action: string;
  targetUserId: string | null;
  before: unknown;
  after: unknown;
}

// Tripwire for the day someone passes a whole row: a key that names a credential is a bug.
export const credentialKey =
  /secret|token|password|pwd|otp|passkey|credential|authorization|cookie|bearer|recovery|code_?hash|private|api_?key/i;

function assertNoCredentials(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentials(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (credentialKey.test(key)) throw new Error(`audit_log must not contain ${path}.${key}`);
      assertNoCredentials(nested, `${path}.${key}`);
    }
  }
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  assertNoCredentials(value);
  return JSON.stringify(value);
}

/**
 * The INSERT as a prepared statement, so a mutation can commit with its audit row in one
 * `DB.batch([...])`: either both land or neither does. All values are bound parameters.
 */
export function auditStatement<Statement extends { run(): Promise<unknown> }>(
  db: AuditDb<Statement>,
  entry: AuditEntry,
  now = Date.now(),
): Statement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, at, actor_id, action, target_user_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      now,
      entry.actor.user.id,
      entry.action,
      entry.targetUserId,
      toJson(entry.before),
      toJson(entry.after),
    );
}

/** Writes one audit row. A failed write throws, so the caller's mutation must not proceed past it. */
export async function audit<Statement extends { run(): Promise<unknown> }>(
  db: AuditDb<Statement>,
  entry: AuditEntry,
  now = Date.now(),
): Promise<void> {
  await auditStatement(db, entry, now).run();
}
