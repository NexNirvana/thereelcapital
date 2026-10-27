// The admin's cross-client history (docs/screens-and-flows.md#admin, /admin/historial). The page
// calls requireAdmin; this module fans the engine's `history` RPC out to each client's Durable
// Object (the same read the client's own screen uses, so no P&L, balance or broker id) and merges.
import { Schema } from "effect";
import { isCalendarDay } from "#lib/domain/calendar.ts";
import { ORDER_STATES } from "#lib/domain/order-states.ts";
import { withTimeout } from "./admin-operations.ts";

export const ADMIN_HISTORY_PAGE_SIZE = 25;
export const ADMIN_EVENTS_SHOWN = 50;

const Day = Schema.Union([
  Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/), Schema.makeFilter(isCalendarDay)),
  Schema.Literal(""),
]);

/** `tipo` picks what is listed: orders (with their fills), all events, or only error events. */
export const HISTORY_TYPES = ["ordenes", "eventos", "errores"] as const;

// Everything the browser may say: unknown parameters are a 400. The mode is SIM only.
export const AdminHistoryQuery = Schema.Struct({
  cliente: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  modo: Schema.optionalKey(Schema.Literal("SIM")),
  cuenta: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  simbolo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  estado: Schema.optionalKey(Schema.Union([Schema.Literals(ORDER_STATES), Schema.Literal("")])),
  tipo: Schema.optionalKey(Schema.Union([Schema.Literals(HISTORY_TYPES), Schema.Literal("")])),
  desde: Schema.optionalKey(Day),
  hasta: Schema.optionalKey(Day),
  despues: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{1,16}:[A-Za-z0-9_-]{1,64}$/)),
  ),
});
export type AdminHistoryQuery = typeof AdminHistoryQuery.Type;

export interface AdminHistoryFilters {
  readonly cliente: string;
  readonly cuenta: string;
  readonly simbolo: string;
  readonly estado: string;
  readonly tipo: string;
  readonly desde: string;
  readonly hasta: string;
}

export function filtersOf(query: AdminHistoryQuery): AdminHistoryFilters {
  return {
    cliente: query.cliente ?? "",
    cuenta: query.cuenta ?? "",
    simbolo: (query.simbolo ?? "").trim().toUpperCase(),
    estado: query.estado ?? "",
    tipo: query.tipo ?? "",
    desde: query.desde ?? "",
    hasta: query.hasta ?? "",
  };
}

// The slice of the engine's `history` the fan-out reads.
export interface ClientIntent {
  readonly id: string;
  readonly kind: string;
  readonly account_id: string;
  readonly symbol: string;
  readonly asset_type: string;
  readonly qty: number;
  readonly state: string;
  readonly filled_qty: number;
  readonly avg_fill_price: number | null;
  readonly source: string;
  readonly reject_reason?: string | null;
  readonly created_at: number;
}
export interface ClientEvent {
  readonly at: number;
  readonly level: string;
  readonly type: string;
  readonly operation?: string | null;
  readonly detail?: string | null;
}
export interface ClientHistory {
  readonly intents: readonly ClientIntent[];
  readonly events: readonly ClientEvent[];
  readonly accounts: readonly string[];
  readonly nextCursor: string | null;
}
export type HistoryReader = (
  clientId: string,
  args: Readonly<Record<string, string>>,
) => Promise<{ ok: true; value: ClientHistory } | { ok: false; message: string }>;

export interface ClientRef {
  readonly id: string;
  readonly email: string;
}

export interface AdminHistoryPage {
  readonly intents: readonly (ClientIntent & { clientEmail: string })[];
  readonly events: readonly (ClientEvent & { clientEmail: string })[];
  readonly accounts: readonly string[];
  /** Clients whose history could not be read: the screen says so instead of hiding their rows. */
  readonly failures: readonly { clientEmail: string; message: string }[];
  readonly nextCursor: string | null;
}

const newestFirst = (a: ClientIntent, b: ClientIntent) =>
  b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Asks every client (or the one filtered) in parallel and merges. The global page is contained in
 * the union of each client's own page after the same cursor, so the merged cursor never skips a
 * row; a client that fails or exceeds the fan-out timeout is reported and the rest still show.
 */
export async function readAdminHistory(
  clients: readonly ClientRef[],
  filters: AdminHistoryFilters,
  cursor: string | undefined,
  read: HistoryReader,
  timeoutMs?: number,
): Promise<AdminHistoryPage> {
  const targets =
    filters.cliente === "" ? clients : clients.filter((c) => c.id === filters.cliente);
  const args: Record<string, string> = {
    mode: "SIM",
    ...(filters.cuenta === "" ? {} : { accountId: filters.cuenta }),
    ...(filters.simbolo === "" ? {} : { symbol: filters.simbolo }),
    ...(filters.estado === "" ? {} : { state: filters.estado }),
    ...(filters.tipo === "errores" ? { level: "error" } : {}),
    ...(filters.desde === "" ? {} : { from: filters.desde }),
    ...(filters.hasta === "" ? {} : { to: filters.hasta }),
    ...(cursor === undefined ? {} : { cursor }),
  };

  const settled = await Promise.all(
    targets.map(async (client) => {
      const result = await withTimeout(() => read(client.id, args), timeoutMs);
      return { client, result };
    }),
  );

  const intents: (ClientIntent & { clientEmail: string })[] = [];
  const events: (ClientEvent & { clientEmail: string })[] = [];
  const accounts = new Set<string>();
  // A client holding more rows than it sent has a next cursor even when the merge fits one page.
  let clientHasMore = false;
  const failures: { clientEmail: string; message: string }[] = [];
  for (const { client, result } of settled) {
    if (result === null || !result.ok) {
      failures.push({
        clientEmail: client.email,
        message: result === null ? "No pudimos leer su historial." : result.message,
      });
      continue;
    }
    clientHasMore ||= result.value.nextCursor !== null;
    for (const row of result.value.intents) intents.push({ ...row, clientEmail: client.email });
    for (const row of result.value.events) events.push({ ...row, clientEmail: client.email });
    for (const account of result.value.accounts) accounts.add(account);
  }

  const showOrders = filters.tipo === "" || filters.tipo === "ordenes";
  const showEvents = filters.tipo !== "ordenes";
  intents.sort(newestFirst);
  const page = showOrders ? intents.slice(0, ADMIN_HISTORY_PAGE_SIZE) : [];
  const last = page.at(-1);
  return {
    intents: page,
    events:
      showEvents && cursor === undefined
        ? events.sort((a, b) => b.at - a.at).slice(0, ADMIN_EVENTS_SHOWN)
        : [],
    accounts: [...accounts].sort(),
    failures,
    nextCursor:
      showOrders &&
      // A failed client's rows newer than the cursor would fall behind the next page: reload retries them.
      failures.length === 0 &&
      (clientHasMore || intents.length > ADMIN_HISTORY_PAGE_SIZE) &&
      last !== undefined
        ? `${last.created_at}:${last.id}`
        : null,
  };
}
