import { describe, expect, it } from "bun:test";
import type { GenericEndpointContext } from "better-auth";
import { auditStartedSession } from "./auth-audit.ts";

const entry = {
  actor: { user: { id: "u1" } },
  action: "auth.sign_in",
  targetUserId: "u1",
  before: null,
  after: null,
};

function fixture(failWrite: boolean) {
  const deleted: string[] = [];
  const db = {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          if (failWrite) throw new Error("D1 down");
        },
      }),
    }),
  };
  // Only the two members the helper reads.
  const ctx = {
    context: {
      newSession: { session: { token: "tok-1" } },
      internalAdapter: {
        deleteSession: async (token: string) => {
          deleted.push(token);
        },
      },
    },
  } as unknown as Pick<GenericEndpointContext, "context">;
  return { db, ctx, deleted };
}

describe("auditStartedSession", () => {
  it("keeps the session when the row is written", async () => {
    const { db, ctx, deleted } = fixture(false);
    await auditStartedSession(db, ctx, entry);
    expect(deleted).toEqual([]);
  });

  it("deletes the session it just started when the write fails, and still fails", async () => {
    const { db, ctx, deleted } = fixture(true);
    await expect(auditStartedSession(db, ctx, entry)).rejects.toThrow("D1 down");
    expect(deleted).toEqual(["tok-1"]);
  });
});
