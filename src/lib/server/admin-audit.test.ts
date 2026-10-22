import { describe, expect, test } from "bun:test";
import { AUDIT_PAGE_SIZE, auditFiltersOf, describeChange, readAudit } from "./admin-audit.ts";
import { sqliteD1 } from "./sqlite-d1.test.ts";

const none = auditFiltersOf({});

function setup() {
  const db = sqliteD1();
  const user = (id: string, email: string, role: string) =>
    db.sqlite.run(
      `INSERT INTO "user" ("id","name","email","emailVerified","role","createdAt","updatedAt") VALUES (?,?,?,0,?,0,0)`,
      [id, id, email, role],
    );
  user("admin-1", "boss@example.com", "admin");
  user("client-1", "cli@example.com", "user");
  const log = (
    id: string,
    at: number,
    action: string,
    target: string | null,
    before: string | null,
    after: string | null,
    actor = "admin-1",
  ) =>
    db.sqlite.run(
      `INSERT INTO audit_log (id, at, actor_id, action, target_user_id, before_json, after_json) VALUES (?,?,?,?,?,?,?)`,
      [id, at, actor, action, target, before, after],
    );
  return { db, log };
}

describe("describeChange", () => {
  test("keeps markup as plain text and never parses it", () => {
    const text = describeChange(JSON.stringify({ note: "<img src=x onerror=alert(1)>" }));
    expect(text).toBe('{"note":"<img src=x onerror=alert(1)>"}');
  });
  test("masks credential-like keys and token-like strings, keeps ids", () => {
    const text = describeChange(
      JSON.stringify({
        size_usd: 20000,
        refresh_token: "abc",
        nested: { clientSecret: "s3", link: `https://x.test/activar/${"A".repeat(43)}` },
        who: "123e4567-e89b-12d3-a456-426614174000",
      }),
    );
    expect(text).toContain('"size_usd":20000');
    expect(text).toContain('"refresh_token":"••••"');
    expect(text).toContain('"clientSecret":"••••"');
    expect(text).toContain('"link":"••••"');
    expect(text).toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(text).not.toContain("AAAAAAAA");
  });
  test("caps the length and survives unreadable json", () => {
    expect(describeChange(JSON.stringify({ a: "x".repeat(1000) }))?.length).toBeLessThan(500);
    expect(describeChange("{not json")).toBe("(no legible)");
    expect(describeChange(null)).toBeNull();
  });
});

describe("readAudit", () => {
  test("shows e-mails for existing users, ids for deleted ones, newest first", async () => {
    const { db, log } = setup();
    log("a", 1, "client.create", "client-1", null, '{"email":"cli@example.com"}');
    log("b", 2, "client.deactivate", "gone-user", null, null, "gone-admin");
    const page = await readAudit(db, none, undefined);
    expect(page.entries.map((e) => [e.action, e.actor, e.target])).toEqual([
      ["client.deactivate", "gone-admin", "gone-user"],
      ["client.create", "boss@example.com", "cli@example.com"],
    ]);
    expect(page.actions).toEqual(["client.create", "client.deactivate"]);
  });

  test("filters combine: actor, action, target and New York dates", async () => {
    const { db, log } = setup();
    const nov4Noon = Date.parse("2026-11-04T17:00:00Z");
    const nov5Early = Date.parse("2026-11-05T05:30:00Z"); // 00:30 on Nov 5 in New York
    log("a", nov4Noon, "client.create", "client-1", null, null);
    log("b", nov5Early, "client.deactivate", "client-1", null, null);
    log("c", nov4Noon, "client.create", "other", null, null, "gone-admin");
    const ids = async (q: Parameters<typeof auditFiltersOf>[0]) =>
      (await readAudit(db, auditFiltersOf(q), undefined)).entries.map((e) => e.id).sort();
    expect(await ids({ actor: "admin-1" })).toEqual(["a", "b"]);
    expect(await ids({ accion: "client.create" })).toEqual(["a", "c"]);
    expect(await ids({ accion: "client.create", objetivo: "client-1" })).toEqual(["a"]);
    expect(await ids({ desde: "2026-11-05" })).toEqual(["b"]);
    expect(await ids({ hasta: "2026-11-04" })).toEqual(["a", "c"]);
    expect(await ids({ actor: "admin-1", desde: "2026-11-04", hasta: "2026-11-04" })).toEqual([
      "a",
    ]);
  });

  test("pages by cursor without skipping or repeating a row", async () => {
    const { db, log } = setup();
    const total = AUDIT_PAGE_SIZE * 2 + 5;
    for (let i = 0; i < total; i++)
      log(`id-${String(i).padStart(3, "0")}`, 1000 + Math.floor(i / 2), "x.y", null, null, null);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await readAudit(db, none, cursor);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
  });

  test("returns before and after as masked text", async () => {
    const { db, log } = setup();
    log(
      "a",
      1,
      "client_settings.update",
      "client-1",
      '{"size_usd":100}',
      '{"size_usd":200,"api_key":"zzz"}',
    );
    const [entry] = (await readAudit(db, none, undefined)).entries;
    expect(entry?.before).toBe('{"size_usd":100}');
    expect(entry?.after).toBe('{"size_usd":200,"api_key":"••••"}');
  });
});
