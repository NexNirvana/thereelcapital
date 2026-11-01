import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClientCoordinator } from "../src/index.ts";
import { newClient, type Client } from "./sync-helpers.ts";

const REFUSED = { ok: false, code: "MODE_NOT_ENABLED" };
const REAL_ENTRY = { mode: "REAL", accountId: "LIVE-1", symbol: "AAPL", assetType: "equity" };
const REAL_SEND = { ...REAL_ENTRY, intentId: "A".repeat(22), confirmedQty: 1 };

/** The test deployment is closed; this stands in for the owner setting REAL_TRADING (test binding only). */
async function openDeployment(client: Client) {
  await runInDurableObject(client.stub, (instance: ClientCoordinator) => {
    Object.assign(instance["env"], { REAL_TRADING: "enabled" });
  });
}

async function setClientFlag(client: Client, enabled: boolean) {
  await env.DB.prepare("UPDATE client_settings SET real_trading_enabled = ? WHERE user_id = ?")
    .bind(enabled ? 1 : 0, client.userId)
    .run();
}

async function openRealPosition(client: Client) {
  await runInDurableObject(client.stub, (_i, state) => {
    state.storage.sql.exec(
      `INSERT INTO positions (id, mode, account_id, symbol, original_qty, avg_entry_price, stop_pct,
         trailing_unlock_pct, protection_state, status, opened_on)
       VALUES ('real-1', 'REAL', 'LIVE-1', 'AAPL', 10, 1, 30, 70, 'unverified', 'OPEN', '2026-11-04')`,
    );
  });
}

const exits = (client: Client) =>
  Promise.all([
    client.stub.exit({ mode: "REAL", positionId: "real-1", step: 0 }),
    client.stub.cancel({ mode: "REAL", intentId: "none" }),
    client.stub.activateTrailing({ mode: "REAL", positionId: "real-1", trailingPct: 10 }),
    client.stub.sync({ mode: "REAL" }),
  ]);

describe("the REAL gate of the RPC surface", () => {
  it("refuses entries, exits, cancels and trailing with the deployment closed even with the flag on", async () => {
    const client = await newClient();
    await setClientFlag(client, true);
    await openRealPosition(client);
    expect(await client.stub.prepareEntry(REAL_ENTRY)).toMatchObject(REFUSED);
    expect(await client.stub.sendEntry(REAL_SEND)).toMatchObject(REFUSED);
    for (const result of await exits(client)) expect(result).toMatchObject(REFUSED);
    expect(await client.stub.history({ mode: "REAL" })).toMatchObject(REFUSED);
  });

  it("refuses REAL entries, option reads and exits with the flag off and nothing open", async () => {
    const client = await newClient();
    await openDeployment(client);
    expect(await client.stub.prepareEntry(REAL_ENTRY)).toMatchObject(REFUSED);
    expect(await client.stub.sendEntry(REAL_SEND)).toMatchObject(REFUSED);
    expect(
      await client.stub.optionChain({ mode: "REAL", underlying: "MSFT", expiration: "2026-11-20" }),
    ).toMatchObject(REFUSED);
    for (const result of await exits(client)) expect(result).toMatchObject(REFUSED);
  });

  it("lets a client with the flag off exit, cancel and read what is open in REAL, but not enter", async () => {
    const client = await newClient();
    await openDeployment(client);
    await openRealPosition(client);
    expect(await client.stub.prepareEntry(REAL_ENTRY)).toMatchObject(REFUSED);
    for (const result of await exits(client)) expect(result).not.toMatchObject(REFUSED);
    expect(await client.stub.history({ mode: "REAL" })).toMatchObject({ ok: true });
    expect(await client.stub.state({ mode: "REAL" })).toMatchObject({ ok: true });
  });

  it("lets REAL entries through to the guards when both switches are on", async () => {
    const client = await newClient();
    await openDeployment(client);
    await setClientFlag(client, true);
    expect(await client.stub.prepareEntry(REAL_ENTRY)).not.toMatchObject(REFUSED);
  });

  it("reads the flag at each call: turning it off refuses the next entry", async () => {
    const client = await newClient();
    await openDeployment(client);
    await setClientFlag(client, true);
    expect(await client.stub.prepareEntry(REAL_ENTRY)).not.toMatchObject(REFUSED);
    await setClientFlag(client, false);
    expect(await client.stub.prepareEntry(REAL_ENTRY)).toMatchObject(REFUSED);
  });

  it("never serves REAL to the connection methods", async () => {
    const client = await newClient();
    await openDeployment(client);
    await setClientFlag(client, true);
    expect(await client.stub.disconnect({ mode: "REAL" })).toMatchObject(REFUSED);
  });
});

describe("modes", () => {
  it("reports what the client may enter and exit", async () => {
    const client = await newClient();
    expect(await client.stub.modes()).toEqual({
      ok: true,
      value: { entries: ["SIM"], exits: ["SIM"] },
    });
    await openDeployment(client);
    expect(await client.stub.modes()).toMatchObject({
      value: { entries: ["SIM"], exits: ["SIM"] },
    });
    await setClientFlag(client, true);
    expect(await client.stub.modes()).toMatchObject({
      value: { entries: ["SIM", "REAL"], exits: ["SIM", "REAL"] },
    });
    await setClientFlag(client, false);
    await openRealPosition(client);
    expect(await client.stub.modes()).toMatchObject({
      value: { entries: ["SIM"], exits: ["SIM", "REAL"] },
    });
  });
});
