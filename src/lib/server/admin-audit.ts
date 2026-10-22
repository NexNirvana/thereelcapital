// The admin's audit screen (docs/screens-and-flows.md#admin, /admin/auditoria): a read of
// `audit_log` with filters and keyset pagination. The page calls requireAdmin. Rows never hold
// credentials (audit.ts refuses them on write); this still masks anything credential-like on read.
import { Schema } from "effect";
import { isCalendarDay, nextCalendarDay, startOfSessionDay } from "#lib/domain/calendar.ts";
import { credentialKey } from "./audit.ts";

export const AUDIT_PAGE_SIZE = 50;
const MAX_CHANGE_CHARS = 400;

const Day = Schema.Union([
  Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/), Schema.makeFilter(isCalendarDay)),
  Schema.Literal(""),
]);

// Unknown parameters are a 400; `despues` is the opaque keyset cursor of the previous page.
export const AuditQuery = Schema.Struct({
  actor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  accion: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  objetivo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  desde: Schema.optionalKey(Day),
  hasta: Schema.optionalKey(Day),
  despues: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{1,16}:[A-Za-z0-9_-]{1,64}$/)),
  ),
});
export type AuditQuery = typeof AuditQuery.Type;

export interface AuditFilters {
  readonly actor: string;
  readonly accion: string;
  readonly objetivo: string;
  readonly desde: string;
  readonly hasta: string;
}

export function auditFiltersOf(query: AuditQuery): AuditFilters {
  return {
    actor: query.actor ?? "",
    accion: query.accion ?? "",
    objetivo: query.objetivo ?? "",
    desde: query.desde ?? "",
    hasta: query.hasta ?? "",
  };
}

export interface AuditDbReader {
  prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results: unknown[] }> } };
}

const Row = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  actor: Schema.String,
  action: Schema.String,
  target: Schema.NullOr(Schema.String),
  before_json: Schema.NullOr(Schema.String),
  after_json: Schema.NullOr(Schema.String),
});
const Option = Schema.Struct({ value: Schema.String, label: Schema.String });

export interface AuditEntryView {
  readonly id: string;
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly before: string | null;
  readonly after: string | null;
}

const MASK = "••••";
// A long unbroken run of token characters is a credential, whatever its key says.
const tokenLike = /[A-Za-z0-9_-]{32,}/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        credentialKey.test(key) ? MASK : maskValue(nested),
      ]),
    );
  }
  return typeof value === "string" && tokenLike.test(value) && !uuid.test(value) ? MASK : value;
}

/**
 * A stored before/after as plain text for the screen: credential-looking keys and token-like
 * strings are masked and the length is capped. The result is only ever rendered as text.
 */
export function describeChange(json: string | null): string | null {
  if (json === null) return null;
  let text: string;
  try {
    text = JSON.stringify(maskValue(JSON.parse(json)));
  } catch {
    return "(no legible)";
  }
  return text.length > MAX_CHANGE_CHARS ? `${text.slice(0, MAX_CHANGE_CHARS)}…` : text;
}

export interface AuditPage {
  readonly entries: readonly AuditEntryView[];
  readonly nextCursor: string | null;
  readonly actors: readonly { value: string; label: string }[];
  readonly actions: readonly string[];
  readonly targets: readonly { value: string; label: string }[];
}

// Users shown by e-mail while they exist; rows outlive users, so the stored id is the fallback.
const WHO = (column: string, alias: string) =>
  `COALESCE((SELECT u."email" FROM "user" u WHERE u."id" = ${column}), ${column}) AS ${alias}`;

export async function readAudit(
  db: AuditDbReader,
  filters: AuditFilters,
  cursor: string | undefined,
): Promise<AuditPage> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filters.actor !== "") {
    where.push("actor_id = ?");
    params.push(filters.actor);
  }
  if (filters.accion !== "") {
    where.push("action = ?");
    params.push(filters.accion);
  }
  if (filters.objetivo !== "") {
    where.push("target_user_id = ?");
    params.push(filters.objetivo);
  }
  if (filters.desde !== "") {
    where.push("at >= ?");
    params.push(startOfSessionDay(filters.desde));
  }
  if (filters.hasta !== "") {
    where.push("at < ?");
    params.push(startOfSessionDay(nextCalendarDay(filters.hasta)));
  }
  if (cursor !== undefined) {
    const [at = "0", id = ""] = cursor.split(":");
    where.push("(at, id) < (?, ?)");
    params.push(Number(at), id);
  }

  const [rows, actors, actions, targets] = await Promise.all([
    db
      .prepare(
        `SELECT id, at, ${WHO("actor_id", "actor")}, action, ${WHO("target_user_id", "target")},
                before_json, after_json
           FROM audit_log ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
          ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .bind(...params, AUDIT_PAGE_SIZE + 1)
      .all(),
    db
      .prepare(
        `SELECT DISTINCT actor_id AS value, ${WHO("actor_id", "label")} FROM audit_log ORDER BY label`,
      )
      .bind()
      .all(),
    db.prepare("SELECT DISTINCT action AS value FROM audit_log ORDER BY action").bind().all(),
    db
      .prepare(
        `SELECT DISTINCT target_user_id AS value, ${WHO("target_user_id", "label")} FROM audit_log
          WHERE target_user_id IS NOT NULL ORDER BY label`,
      )
      .bind()
      .all(),
  ]);

  const decoded = Schema.decodeUnknownSync(Schema.Array(Row))(rows.results);
  const shown = decoded.slice(0, AUDIT_PAGE_SIZE);
  const last = shown.at(-1);
  return {
    entries: shown.map((row) => ({
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      target: row.target,
      before: describeChange(row.before_json),
      after: describeChange(row.after_json),
    })),
    nextCursor:
      decoded.length > AUDIT_PAGE_SIZE && last !== undefined ? `${last.at}:${last.id}` : null,
    actors: Schema.decodeUnknownSync(Schema.Array(Option))(actors.results),
    actions: Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ value: Schema.String })))(
      actions.results,
    ).map((row) => row.value),
    targets: Schema.decodeUnknownSync(Schema.Array(Option))(targets.results),
  };
}
