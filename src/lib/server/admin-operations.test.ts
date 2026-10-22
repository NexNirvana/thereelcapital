import { describe, expect, test } from "bun:test";
import type { ClientOverview } from "#lib/domain/overview.ts";
import { fetchOverviews, settled } from "./admin-operations.ts";

const overview: ClientOverview = {
  connection: { status: "NOT_CONNECTED" },
  positionsOpen: 0,
  maxPositions: 2,
  entriesToday: 0,
  maxEntries: 3,
  positions: [],
  orders: [],
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

describe("fetchOverviews", () => {
  test("one failing and one hanging object still render the others, in order", async () => {
    const clients = [
      { id: "a", email: "a@x.test" },
      { id: "b", email: "b@x.test" },
      { id: "c", email: "c@x.test" },
      { id: "d", email: "d@x.test" },
    ];
    const asked: unknown[] = [];
    const rows = await fetchOverviews(
      clients,
      (id) => ({
        overview: (input) => {
          asked.push(input);
          if (id === "b") return Promise.reject(new Error("boom"));
          if (id === "c") return new Promise(() => {});
          return Promise.resolve({ ok: true as const, value: overview });
        },
      }),
      20,
    );
    expect(rows.map((r) => [r.id, r.overview.status])).toEqual([
      ["a", "ok"],
      ["b", "unavailable"],
      ["c", "unavailable"],
      ["d", "ok"],
    ]);
    expect(asked).toEqual(Array(4).fill({ mode: "SIM" }));
  });
});
