// Operational log and errors of one client (docs/architecture.md#data-model). No P&L, no secrets.

import { EVENT_RETENTION_MS } from "#lib/domain/config.ts";
import type { Mode } from "./mode.ts";

export type EventLevel = "info" | "warn" | "error";

export interface EngineEvent {
  readonly mode: Mode;
  readonly level: EventLevel;
  readonly type: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Defense in depth: credential-like keys never reach the log even if a caller passes them. */
const SECRET_KEY = /token|secret|password|authorization|credential|api_?key|otp|recovery/i;

function scrub(data: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(data, (key, value: unknown) =>
    SECRET_KEY.test(key) ? "[redacted]" : value,
  );
}

/** `now` is passed in (epoch ms) so the writer stays deterministic. */
export function writeEvent(sql: SqlStorage, now: number, event: EngineEvent): void {
  sql.exec(
    "INSERT INTO events (at, mode, level, type, message, data_json) VALUES (?, ?, ?, ?, ?, ?)",
    now,
    event.mode,
    event.level,
    event.type,
    event.message,
    event.data === undefined ? null : scrub(event.data),
  );
}

/**
 * The one-line event every engine module writes: SIM only, `message` is the type. `data` is limited to
 * counts, ids and statuses by the callers; the writer also scrubs secret-like keys.
 */
export function logEvent(
  ctx: { readonly sql: SqlStorage; readonly now: number },
  level: EventLevel,
  type: string,
  data?: Readonly<Record<string, unknown>>,
): void {
  writeEvent(ctx.sql, ctx.now, { mode: "SIM", level, type, message: type, data });
}

/** Drops a mode's events past the retention window (D22); scoped by mode to use `events_by_mode_at`. */
export function pruneEvents(sql: SqlStorage, now: number, mode: Mode): void {
  sql.exec("DELETE FROM events WHERE mode = ? AND at < ?", mode, now - EVENT_RETENTION_MS);
}
