// Operational log and errors of one client (docs/architecture.md#data-model). No P&L, no secrets.

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
