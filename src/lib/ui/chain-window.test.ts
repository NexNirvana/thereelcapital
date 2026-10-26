import { describe, expect, test } from "bun:test";
import {
  countOptions,
  exactStrike,
  isInTheMoney,
  matchStrikes,
  parseStrike,
  parseStrikeCount,
  priceLineBefore,
  strikeNearest,
  strikeWindow,
  windowSummary,
} from "./chain-window.ts";

const usd = (dollars: number) => Math.round(dollars * 1_000_000);
// 100, 102.5, 105 ... 200 and 215, 217.5.
const strikes = [...Array.from({ length: 41 }, (_, i) => usd(100 + i * 2.5)), usd(215), usd(217.5)];
const sorted = [...strikes].sort((a, b) => a - b);
const dollars = (list: ReadonlyArray<number>) => list.map((micros) => micros / 1_000_000);

describe("strikeWindow", () => {
  test("keeps n/2 strikes on each side of the price", () => {
    const shown = strikeWindow(sorted, 10, usd(151));
    expect(dollars(shown)).toEqual([140, 142.5, 145, 147.5, 150, 152.5, 155, 157.5, 160, 162.5]);
    // 5 below the price and 5 from the first strike at or above it (152.5) on.
    expect(shown).toHaveLength(10);
  });

  test("follows the strike nearest a live price: the window moves only when the price crosses a gap", () => {
    const around = (price: number) =>
      strikeWindow(sorted, 10, strikeNearest(sorted, usd(price))).join();
    // 150 to 152.5 is one gap's half on each side: every tick between 148.75 and 151.25 is the same window.
    expect(around(148.8)).toBe(around(151.2));
    expect(around(149.9)).toBe(around(150.1));
    // Crossing the midpoint to the next strike (151.25) moves it by one strike.
    expect(around(151.3)).not.toBe(around(151.2));
    expect(dollars(strikeWindow(sorted, 10, strikeNearest(sorted, usd(151.3))))[0]).toBe(140);
  });

  test("slides back inside the list near either end", () => {
    expect(dollars(strikeWindow(sorted, 10, usd(100)))[0]).toBe(100);
    expect(dollars(strikeWindow(sorted, 10, usd(217.5))).at(-1)).toBe(217.5);
    expect(strikeWindow(sorted, 10, usd(1)).length).toBe(10);
    expect(strikeWindow(sorted, 10, usd(9999)).length).toBe(10);
  });

  test("centers on a typed strike and shows everything for «all» or a short list", () => {
    expect(dollars(strikeWindow(sorted, 10, usd(200)))).toContain(200);
    expect(strikeWindow(sorted, "all", usd(150))).toBe(sorted);
    const few = [usd(1), usd(2)];
    expect(strikeWindow(few, 50, usd(1))).toBe(few);
  });

  test("falls back to the middle of the list without a price", () => {
    const shown = strikeWindow(sorted, 10, null);
    expect(shown).toHaveLength(10);
    expect(shown).toContain(sorted[Math.floor(sorted.length / 2)] ?? 0);
  });
});

describe("parseStrike and exactStrike", () => {
  test("reads plain amounts only", () => {
    expect(parseStrike("402.5")).toBe(usd(402.5));
    expect(parseStrike("402,5")).toBe(usd(402.5));
    expect(parseStrike(" 400 ")).toBe(usd(400));
    expect(parseStrike("")).toBeNull();
    expect(parseStrike("4e2")).toBeNull();
    expect(parseStrike("-5")).toBeNull();
    expect(parseStrike("abc")).toBeNull();
  });

  test("finds only a strike that is listed", () => {
    expect(exactStrike(sorted, "102.5")).toBe(usd(102.5));
    expect(exactStrike(sorted, "102.50")).toBe(usd(102.5));
    expect(exactStrike(sorted, "103")).toBeNull();
  });
});

describe("matchStrikes", () => {
  test("orders the strikes that start with the text by distance to the price", () => {
    const found = matchStrikes(sorted, "2", usd(215));
    expect(found.kind).toBe("match");
    expect(dollars(found.strikes).slice(0, 3)).toEqual([215, 217.5, 200]);
  });

  test("lists at most eight suggestions", () => {
    expect(matchStrikes(sorted, "1", usd(150)).strikes).toHaveLength(8);
  });

  test("offers the nearest strike below and above when nothing matches", () => {
    const found = matchStrikes(sorted, "203", usd(150));
    expect(found.kind).toBe("nearest");
    expect(dollars(found.strikes)).toEqual([200, 215]);
  });

  test("offers one side at the ends of the list and nothing for text that is not an amount", () => {
    expect(dollars(matchStrikes(sorted, "9", null).strikes)).toEqual([100]);
    expect(matchStrikes(sorted, "x", null).strikes).toEqual([]);
  });
});

describe("countOptions", () => {
  test("shows the strike range each choice would give", () => {
    const options = countOptions(sorted, usd(151));
    expect(options.map((option) => option.label)).toEqual([
      "10 strikes",
      "25 strikes",
      "50 strikes",
      "Todos",
    ]);
    expect(options[0]?.range).toBe("140–162.50");
    expect(options[3]?.range).toBe("43 · 100–217.50");
  });

  test("parses the URL parameter with 10 as the default", () => {
    expect(parseStrikeCount("25")).toBe(25);
    expect(parseStrikeCount("todos")).toBe("all");
    expect(parseStrikeCount("7")).toBe(10);
    expect(parseStrikeCount(undefined)).toBe(10);
  });
});

describe("windowSummary", () => {
  const shown = strikeWindow(sorted, 10, usd(151));
  test("says what is shown and around what", () => {
    expect(windowSummary(43, shown, 10, null)).toBe(
      "Mostrando 10 de 43 strikes (140–162.50), centrados en el precio actual.",
    );
    expect(windowSummary(43, shown, 10, usd(150))).toBe(
      "Mostrando 10 de 43 strikes (140–162.50), centrados en el strike 150.",
    );
    expect(windowSummary(43, sorted, "all", usd(150))).toBe(
      "Mostrando los 43 strikes (100–217.50), con el 150 resaltado.",
    );
  });
});

describe("price line and shading", () => {
  test("a call is in the money below the price and a put above it", () => {
    expect(isInTheMoney("call", usd(100), usd(150))).toBe(true);
    expect(isInTheMoney("call", usd(150), usd(150))).toBe(false);
    expect(isInTheMoney("put", usd(160), usd(150))).toBe(true);
    expect(isInTheMoney("put", usd(100), usd(150))).toBe(false);
    expect(isInTheMoney("call", usd(100), null)).toBe(false);
  });

  test("the price line goes before the first strike at or above the price", () => {
    expect(priceLineBefore([usd(1), usd(2), usd(3)], usd(2.5))).toBe(2);
    expect(priceLineBefore([usd(1), usd(2), usd(3)], usd(1))).toBe(0);
    // A price outside the strikes on screen has no line.
    expect(priceLineBefore([usd(1), usd(2)], usd(5))).toBeNull();
    expect(priceLineBefore([usd(2), usd(3)], usd(1))).toBeNull();
    expect(priceLineBefore([usd(1)], null)).toBeNull();
  });

  test("the nearest strike to the price", () => {
    expect(strikeNearest(sorted, usd(151))).toBe(usd(150));
    expect(strikeNearest([], usd(1))).toBeNull();
  });
});
