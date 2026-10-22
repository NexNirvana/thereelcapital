import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ClientCoordinator } from "../src/index.ts";
import { HISTORY_PAGE_SIZE } from "../src/history.ts";

function stubFor(name: string) {
  return env.COORDINATOR.getByName(name);
}

type Seed = { id: string; account?: string; symbol?: string; createdAt: number; state?: string };

async function seed(stub: ReturnType<typeof stubFor>, intents: readonly Seed[]) {
  await runInDurableObject(stub, (_i, state) => {
    for (const row of intents) {
      state.storage.sql.exec(
        `INSERT INTO intents (id, mode, kind, account_id, symbol, asset_type, trade_action, qty, state,
           filled_qty, avg_fill_price, order_confirm_id, broker_order_id, created_at, updated_at)
         VALUES (?, 'SIM', 'entry', ?, ?, 'equity', 'BUY', 10, ?, 10, 101000000, ?, 'secret-broker-id', ?, ?)`,
        row.id,
        row.account ?? "SIM1",
        row.symbol ?? "AAPL",
        row.state ?? "FILLED",
        row.id,
        row.createdAt,
        row.createdAt + 5,
      );
    }
  });
}

async function addEvent(stub: ReturnType<typeof stubFor>, at: number, type: string) {
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(
      "INSERT INTO events (at, mode, level, type, message, data_json) VALUES (?, 'SIM', 'info', ?, ?, '{\"detail\":1}')",
      at,
      type,
      type,
    );
  });
}

async function history(stub: ReturnType<typeof stubFor>, args: object = {}) {
  const result = await stub.history({ mode: "SIM", ...args });
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

describe("history", () => {
  it("pages newest first by cursor without skipping or repeating an order", async () => {
    const stub = stubFor("hist-pages");
    // Three orders share a timestamp: the id breaks the tie, so the cursor must too.
    const total = HISTORY_PAGE_SIZE * 2 + 3;
    await seed(
      stub,
      Array.from({ length: total }, (_, i) => ({
        id: `i${i}`,
        createdAt: 1000 + Math.floor(i / 2),
      })),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await history(stub, cursor === undefined ? {} : { cursor });
      expect(page.intents.length).toBeLessThanOrEqual(HISTORY_PAGE_SIZE);
      seen.push(...page.intents.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(total);
    const order = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ id: string }>("SELECT id FROM intents ORDER BY created_at DESC, id DESC")
        .toArray()
        .map((row) => row.id),
    );
    expect(seen).toEqual(order);
  });

  it("has no next page when the orders fit exactly", async () => {
    const stub = stubFor("hist-exact");
    await seed(
      stub,
      Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => ({ id: `e${i}`, createdAt: i })),
    );
    expect((await history(stub)).nextCursor).toBeNull();
  });

  it("filters by account, symbol and New York day", async () => {
    const stub = stubFor("hist-filters");
    // 2026-11-04 is EST (UTC-5); 2026-10-30 is EDT (UTC-4).
    const nov4Noon = Date.parse("2026-11-04T17:00:00Z");
    const nov4LateEvening = Date.parse("2026-11-05T04:30:00Z"); // 23:30 on Nov 4 in New York
    const nov5Early = Date.parse("2026-11-05T05:30:00Z"); // 00:30 on Nov 5 in New York
    const oct30 = Date.parse("2026-10-30T16:00:00Z");
    await seed(stub, [
      { id: "a", account: "SIM1", symbol: "AAPL", createdAt: nov4Noon },
      { id: "b", account: "SIM2", symbol: "MSFT", createdAt: nov4LateEvening },
      { id: "c", account: "SIM1", symbol: "MSFT", createdAt: nov5Early },
      { id: "d", account: "SIM1", symbol: "AAPL", createdAt: oct30 },
    ]);
    const ids = async (args: object) => (await history(stub, args)).intents.map((r) => r.id);

    expect(await ids({ accountId: "SIM2" })).toEqual(["b"]);
    expect(await ids({ symbol: "msft" })).toEqual(["c", "b"]);
    expect(await ids({ from: "2026-11-04", to: "2026-11-04" })).toEqual(["b", "a"]);
    expect(await ids({ from: "2026-11-05" })).toEqual(["c"]);
    expect(await ids({ to: "2026-10-30" })).toEqual(["d"]);
    expect(await ids({ accountId: "SIM1", symbol: "AAPL", from: "2026-11-01" })).toEqual(["a"]);
    expect((await history(stub)).accounts).toEqual(["SIM1", "SIM2"]);
  });

  it("narrows orders by state and events by level", async () => {
    const stub = stubFor("hist-state-level");
    await seed(stub, [
      { id: "f", createdAt: 10, state: "FILLED" },
      { id: "r", createdAt: 11, state: "REJECTED" },
    ]);
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO events (at, mode, level, type, message) VALUES (1, 'SIM', 'error', 'entry.rejected', 'x'), (2, 'SIM', 'info', 'broker.connected', 'x')",
      );
    });
    expect((await history(stub, { state: "REJECTED" })).intents.map((r) => r.id)).toEqual(["r"]);
    expect((await history(stub, { level: "error" })).events.map((e) => e.type)).toEqual([
      "entry.rejected",
    ]);
    const bad = await stub.history({ mode: "SIM", state: "NOPE" });
    expect(bad.ok).toBe(false);
  });

  it("returns events narrowed by date, on the first page only, without internal detail", async () => {
    const stub = stubFor("hist-events");
    await seed(
      stub,
      Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => ({ id: `v${i}`, createdAt: 10 + i })),
    );
    await addEvent(stub, Date.parse("2026-11-04T17:00:00Z"), "reconcile.position_opened");
    await addEvent(stub, Date.parse("2026-10-01T17:00:00Z"), "broker.connected");

    const first = await history(stub);
    expect(first.events.map((e) => e.type)).toEqual([
      "reconcile.position_opened",
      "broker.connected",
    ]);
    expect(Object.keys(first.events[0] ?? {}).sort()).toEqual(["at", "level", "type"]);
    expect((await history(stub, { from: "2026-11-01" })).events).toHaveLength(1);
    const second = await history(stub, { cursor: first.nextCursor });
    expect(second.events).toEqual([]);
  });

  it("never exposes broker ids, confirm ids or quotes", async () => {
    const stub = stubFor("hist-fields");
    await seed(stub, [{ id: "x", createdAt: 5 }]);
    const [row] = (await history(stub)).intents;
    expect(JSON.stringify(row)).not.toContain("secret-broker-id");
    expect(Object.keys(row ?? {})).not.toContain("quote_json");
    expect(Object.keys(row ?? {})).not.toContain("broker_order_id");
  });

  it("is scoped to the client whose object is asked", async () => {
    const alice = stubFor("hist-alice");
    const bob = stubFor("hist-bob");
    await seed(alice, [{ id: "mine", createdAt: 1 }]);
    expect((await history(bob)).intents).toEqual([]);
    expect((await history(alice)).intents).toHaveLength(1);
  });

  it("refuses REAL and malformed arguments without reading", async () => {
    const stub = stubFor("hist-refuse");
    await seed(stub, [{ id: "r", createdAt: 1 }]);
    expect(await stub.history({ mode: "REAL" })).toMatchObject({ ok: false, code: "MODE_NOT_SIM" });
    expect(await stub.history({ mode: "REAL", from: "nope" })).toMatchObject({
      code: "MODE_NOT_SIM",
    });
    for (const bad of [
      { from: "2026-13-01" },
      { from: "2026-02-31" },
      { to: "9999-12-31" },
      { from: "yesterday" },
      { cursor: "1;DROP TABLE intents" },
      { cursor: "abc:r" },
      { cursor: "1.5:r" },
      { cursor: "-1:r" },
      { cursor: "1e3:r" },
      { cursor: "5:" },
      { cursor: ":r" },
      { clientId: "other" },
      { limit: 5000 },
    ]) {
      expect(await stub.history({ mode: "SIM", ...bad })).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
      });
    }
  });

  it("is read again by a new instance over the same storage, as after an eviction or redeploy", async () => {
    const stub = stubFor("hist-restart");
    await seed(stub, [{ id: "kept", createdAt: 7 }]);
    await addEvent(stub, 8, "broker.connected");
    const reread = await runInDurableObject(stub, async (_instance, state) => {
      const fresh = new ClientCoordinator(state, env);
      return fresh.history({ mode: "SIM" });
    });
    expect(reread).toMatchObject({
      ok: true,
      value: { intents: [{ id: "kept" }], events: [{ type: "broker.connected" }] },
    });
  });
});
