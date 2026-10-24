import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("font preloads", () => {
  const preloaded = [
    ...read("src/app.html").matchAll(/<link\s+rel="preload"\s+href="([^"]+)"([^>]*)>/g),
  ];

  test("preloads the latin 400 and 600 faces as crossorigin woff2", () => {
    expect(preloaded.map((match) => match[1])).toEqual([
      "/fonts/ibm-plex-mono-latin-400-normal.woff2",
      "/fonts/ibm-plex-mono-latin-600-normal.woff2",
    ]);
    for (const match of preloaded) {
      expect(match[2]).toContain('as="font"');
      expect(match[2]).toContain('type="font/woff2"');
      expect(match[2]).toContain("crossorigin");
    }
  });

  test("each preloaded file exists and is the one base.css declares", () => {
    const css = read("src/lib/ui/base.css");
    for (const match of preloaded) {
      expect(existsSync(new URL(`../../../static${match[1]}`, import.meta.url))).toBe(true);
      expect(css).toContain(`url("${match[1]}")`);
    }
  });

  test("serves /fonts/* as immutable for a year", () => {
    expect(read("_headers")).toMatch(
      /\/fonts\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/,
    );
  });
});
