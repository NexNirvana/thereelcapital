import { describe, expect, test } from "bun:test";
import type { ClientOverview } from "#lib/domain/overview.ts";
import { readRealState, settled, startOverviews } from "./admin-operations.ts";

const overview: ClientOverview = {
  connection: { status: "NOT_CONNECTED" },
  positionsOpen: 0,
  maxPositions: 2,
  entriesToday: 0,
  maxEntries: 3,
  positions: [],
  orders: [],
  realListing: null,
};

describe("settled", () => {
  test("returns the value of a successful call", async () => {
    expect(await settled(async () => ({ ok: true as const, value: 7 }))).toEqual({
      status: "ok",
      value: 7,
    });
  });

  test("reads an engine error, a rejection and a timeout as unavailable", async () => {
    expect(await settled(async () => ({ ok: false as const }))).toEqual({ status: "unavailable" });
    expect(
      await settled(async () => {
        throw new Error("DO reset");
      }),
    ).toEqual({ status: "unavailable" });
    const never = () => new Promise<never>(() => {});
    expect(await settled(never, 20)).toEqual({ status: "unavailable" });
  });
});

describe("startOverviews", () => {
  test("one failing and one hanging object still render the others, in order", async () => {
    const clients = [
      { id: "a", email: "a@x.test" },
      { id: "b", email: "b@x.test" },
      { id: "c", email: "c@x.test" },
      { id: "d", email: "d@x.test" },
    ];
    const asked: unknown[] = [];
    const started = startOverviews(
      clients,
      (id) => ({
        overview: (input) => {
          asked.push(input);
          if (id === "b") return Promise.reject(new Error("boom"));
          if (id === "c") return new Promise(() => {});
          return Promise.resolve({ ok: true as const, value: overview });
        },
      }),
      "SIM",
      20,
    );
    const rows = await Promise.all(
      started.map(async (row) => ({ ...row, overview: await row.overview })),
    );
    expect(rows.map((r) => [r.id, r.overview.status])).toEqual([
      ["a", "ok"],
      ["b", "unavailable"],
      ["c", "unavailable"],
      ["d", "ok"],
    ]);
    expect(asked).toEqual(Array(4).fill({ mode: "SIM" }));
  });

  test("a call that throws synchronously reads as unavailable", async () => {
    expect(
      await settled(() => {
        throw new Error("no namespace");
      }),
    ).toEqual({ status: "unavailable" });
  });

  test("returns the rows before any object answers, and one slow object delays only its row", async () => {
    let release: () => void = () => {};
    const slow = new Promise<{ ok: true; value: ClientOverview }>((resolve) => {
      release = () => resolve({ ok: true, value: overview });
    });
    const started = startOverviews(
      [
        { id: "fast", email: "f@x.test" },
        { id: "slow", email: "s@x.test" },
      ],
      (id) => ({
        overview: () => (id === "slow" ? slow : Promise.resolve({ ok: true, value: overview })),
      }),
      "SIM",
      1_000,
    );
    expect(started.map((r) => r.id)).toEqual(["fast", "slow"]);
    expect((await started[0]!.overview).status).toBe("ok");
    let slowDone = false;
    void started[1]!.overview.then(() => (slowDone = true));
    await Promise.resolve();
    expect(slowDone).toBe(false);
    release();
    expect((await started[1]!.overview).status).toBe("ok");
  });
});

describe("readRealState", () => {
  const answer = (entries: readonly ("SIM" | "REAL")[], exits: readonly ("SIM" | "REAL")[]) => ({
    modes: async () => ({ ok: true as const, value: { entries, exits } }),
  });

  test("reads a closed deployment from the engine's modes, not from a variable", async () => {
    expect(await readRealState(true, answer(["SIM"], ["SIM"]))).toEqual({
      status: "ok",
      value: "closed",
    });
  });

  test("reads active and exits-only", async () => {
    expect(await readRealState(true, answer(["SIM", "REAL"], ["SIM", "REAL"]))).toEqual({
      status: "ok",
      value: "active",
    });
    expect(await readRealState(false, answer(["SIM"], ["SIM", "REAL"]))).toEqual({
      status: "ok",
      value: "exits-only",
    });
  });

  test("reads an engine error or a timeout as unavailable", async () => {
    expect(await readRealState(true, { modes: async () => ({ ok: false as const }) })).toEqual({
      status: "unavailable",
    });
    expect(await readRealState(true, { modes: () => new Promise(() => undefined) }, 5)).toEqual({
      status: "unavailable",
    });
  });
});
