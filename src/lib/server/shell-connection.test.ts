import { describe, expect, test } from "bun:test";
import { shellConnection } from "./shell-connection.ts";

const connected = {
  status: "CONNECTED" as const,
  health: { status: "ok" as const },
  entriesBlocked: false,
  accounts: [{ accountId: "SIM1", accountType: "Cash" as const }],
  refreshExpiresAt: 1_000,
  lastSyncAt: 5,
};

describe("shellConnection", () => {
  test("is null when the engine could not be reached", () => {
    expect(shellConnection(null)).toBeNull();
  });

  test("carries an engine refusal as its message", () => {
    expect(shellConnection({ ok: false, message: "No disponible" })).toEqual({
      ok: false,
      message: "No disponible",
    });
  });

  test("keeps only the status when there is no connection", () => {
    expect(shellConnection({ ok: true, value: { status: "NOT_CONNECTED" } })).toEqual({
      ok: true,
      view: { status: "NOT_CONNECTED" },
    });
  });

  test("copies the connected view, with its last good sync, and drops every field it does not name", () => {
    const account = { accountId: "SIM1", accountType: "Cash" as const, token: "x" };
    const leaky = {
      ...connected,
      accounts: [account],
      mode: "SIM",
      refreshToken: "secret",
    };
    const result = shellConnection({ ok: true, value: leaky });
    expect(result).toEqual({ ok: true, view: connected });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("token");
  });
});

describe("an engine still on the previous code", () => {
  test("reads a connected view without lastSyncAt as null", () => {
    const old: Omit<typeof connected, "lastSyncAt"> & { lastSyncAt?: number } = { ...connected };
    delete old.lastSyncAt;
    expect(shellConnection({ ok: true, value: old })).toEqual({
      ok: true,
      view: { ...connected, lastSyncAt: null },
    });
  });
});

describe("one connection read per trader page load", () => {
  const read = (path: string) =>
    Bun.file(new URL(`../../routes/(app)/${path}`, import.meta.url)).text();

  test("only the layout asks the engine; /operar and /conexion take it from parent()", async () => {
    expect(await read("+layout.server.ts")).toContain(".connection(");
    for (const page of ["operar/+page.server.ts", "conexion/+page.server.ts"]) {
      const source = await read(page);
      expect(source).not.toContain(".connection(");
      expect(source).toContain("parent()");
    }
  });

  test("the chain refresh invalidates its own key, not the whole page", async () => {
    expect(await read("operar/+page.server.ts")).toContain('depends("app:chain")');
    const view = await read("../../lib/ui/OptionChainPanel.svelte");
    expect(view).toContain('invalidate("app:chain")');
    expect(view).not.toContain("invalidateAll");
  });
});
