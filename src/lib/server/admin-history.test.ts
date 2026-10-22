import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ADMIN_HISTORY_PAGE_SIZE,
  AdminHistoryQuery,
  filtersOf,
  readAdminHistory,
  type ClientHistory,
  type ClientIntent,
  type HistoryReader,
} from "./admin-history.ts";

const intent = (id: string, created_at: number): ClientIntent => ({
  id,
  kind: "entry",
  account_id: "SIM1",
  symbol: "AAPL",
  asset_type: "equity",
  qty: 10,
  state: "FILLED",
  filled_qty: 10,
  avg_fill_price: 1,
  source: "app",
  created_at,
});

const clients = [
  { id: "c1", email: "a@example.com" },
  { id: "c2", email: "b@example.com" },
];
const none = filtersOf({});

// A fake engine: each client holds rows and pages them the way the DO does.
function readerOf(
  rows: Record<string, ClientIntent[]>,
  seen: { clientId: string; args: Record<string, string> }[] = [],
): HistoryReader {
  return async (clientId, args) => {
    seen.push({ clientId, args });
    const all = [...(rows[clientId] ?? [])].sort(
      (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
    );
    const after = args["cursor"]?.split(":");
    const rest = after
      ? all.filter(
          (r) =>
            r.created_at < Number(after[0]) ||
            (r.created_at === Number(after[0]) && r.id < String(after[1])),
        )
      : all;
    const page = rest.slice(0, ADMIN_HISTORY_PAGE_SIZE);
    const last = page.at(-1);
    const value: ClientHistory = {
      intents: page,
      events: [],
      accounts: ["SIM1"],
      nextCursor:
        rest.length > ADMIN_HISTORY_PAGE_SIZE && last ? `${last.created_at}:${last.id}` : null,
    };
    return { ok: true, value };
  };
}

describe("readAdminHistory", () => {
  test("pages across clients newest first without skipping or repeating a row", async () => {
    const rows = {
      c1: Array.from({ length: 40 }, (_, i) => intent(`a${i}`, 1000 + i * 2)),
      c2: Array.from({ length: 40 }, (_, i) => intent(`b${i}`, 1001 + i * 2)),
    };
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await readAdminHistory(clients, none, cursor, readerOf(rows));
      expect(page.intents.length).toBeLessThanOrEqual(ADMIN_HISTORY_PAGE_SIZE);
      seen.push(...page.intents.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen.length).toBe(80);
    expect(new Set(seen).size).toBe(80);
    expect(seen[0]).toBe("b39");
    expect(seen.at(-1)).toBe("a0");
  });

  test("offers a next page when one client has more rows than the merge shows", async () => {
    const rows = { c1: Array.from({ length: 30 }, (_, i) => intent(`a${i}`, 1000 + i)) };
    const first = await readAdminHistory(clients, none, undefined, readerOf(rows));
    expect(first.intents.length).toBe(ADMIN_HISTORY_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const second = await readAdminHistory(
      clients,
      none,
      first.nextCursor ?? undefined,
      readerOf(rows),
    );
    expect(second.intents.length).toBe(5);
    expect(second.nextCursor).toBeNull();
  });

  test("tags each row with its client and narrows to one client", async () => {
    const rows = { c1: [intent("x", 5)], c2: [intent("y", 6)] };
    const all = await readAdminHistory(clients, none, undefined, readerOf(rows));
    expect(all.intents.map((r) => [r.id, r.clientEmail])).toEqual([
      ["y", "b@example.com"],
      ["x", "a@example.com"],
    ]);
    const seen: { clientId: string; args: Record<string, string> }[] = [];
    const one = await readAdminHistory(
      clients,
      filtersOf({ cliente: "c1" }),
      undefined,
      readerOf(rows, seen),
    );
    expect(one.intents.map((r) => r.id)).toEqual(["x"]);
    expect(seen.map((s) => s.clientId)).toEqual(["c1"]);
  });

  test("passes the filters to the engine as its own arguments and always SIM", async () => {
    const seen: { clientId: string; args: Record<string, string> }[] = [];
    await readAdminHistory(
      clients,
      filtersOf({
        cuenta: "SIM1",
        simbolo: " msft ",
        estado: "REJECTED",
        tipo: "errores",
        desde: "2026-11-01",
        hasta: "2026-11-04",
      }),
      "5:abc",
      readerOf({}, seen),
    );
    expect(seen[0]?.args).toEqual({
      mode: "SIM",
      accountId: "SIM1",
      symbol: "MSFT",
      state: "REJECTED",
      level: "error",
      from: "2026-11-01",
      to: "2026-11-04",
      cursor: "5:abc",
    });
  });

  test("reports a failing client and still shows the others", async () => {
    const good = readerOf({ c2: [intent("y", 6)] });
    const read: HistoryReader = (id, args) =>
      id === "c1" ? Promise.reject(new Error("boom: secret-detail")) : good(id, args);
    const page = await readAdminHistory(clients, none, undefined, read);
    expect(page.intents.map((r) => r.id)).toEqual(["y"]);
    expect(page.failures).toEqual([
      { clientEmail: "a@example.com", message: "No pudimos leer su historial." },
    ]);
    expect(JSON.stringify(page)).not.toContain("secret-detail");
  });

  test("an engine refusal is reported with the engine's own Spanish message", async () => {
    const read: HistoryReader = async () => ({
      ok: false,
      message: "Los datos enviados no son válidos.",
    });
    const page = await readAdminHistory(clients, none, undefined, read);
    expect(page.failures.length).toBe(2);
    expect(page.intents).toEqual([]);
  });

  test("the orders-only type lists no events and the events types no orders", async () => {
    const read: HistoryReader = async () => ({
      ok: true,
      value: {
        intents: [intent("x", 5)],
        events: [{ at: 9, level: "error", type: "entry.rejected" }],
        accounts: [],
        nextCursor: null,
      },
    });
    const orders = await readAdminHistory(clients, filtersOf({ tipo: "ordenes" }), undefined, read);
    expect(orders.events).toEqual([]);
    expect(orders.intents.length).toBe(2);
    const events = await readAdminHistory(clients, filtersOf({ tipo: "eventos" }), undefined, read);
    expect(events.intents).toEqual([]);
    expect(events.events.length).toBe(2);
  });
});

describe("AdminHistoryQuery", () => {
  const decode = (input: unknown) =>
    Schema.decodeUnknownResult(AdminHistoryQuery, { onExcessProperty: "error" })(input)._tag;
  test("rejects unknown parameters, REAL mode, bad states and impossible dates", () => {
    expect(decode({ cliente: "c1", estado: "FILLED", tipo: "errores" })).toBe("Success");
    expect(decode({ extra: "1" })).toBe("Failure");
    expect(decode({ modo: "REAL" })).toBe("Failure");
    expect(decode({ estado: "NOPE" })).toBe("Failure");
    expect(decode({ desde: "2026-02-31" })).toBe("Failure");
    expect(decode({ despues: "1; DROP" })).toBe("Failure");
  });
});
