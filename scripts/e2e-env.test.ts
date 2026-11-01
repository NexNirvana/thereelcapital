import { expect, test } from "bun:test";

// D52: the e2e engine may open the REAL switch only because the same file pins the local simulation.
test("the e2e engine env opens REAL only together with the local simulation", async () => {
  const text = await Bun.file(new URL("../tests/e2e/engine.env", import.meta.url)).text();
  const vars = Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  if (vars["REAL_TRADING"] === "enabled") {
    expect(vars["BROKER"]).toBe("local-sim");
    expect(vars["ENVIRONMENT"]).toBe("test");
  }
});
