import { describe, expect, it } from "bun:test";
import { isHttpError } from "@sveltejs/kit";
import { Schema } from "effect";
import { decode } from "./decode";
import { engineFor, engineForClient } from "./engine";
import { freshSessionMaxAgeMs, requireAdmin, requireFreshSession, requireUser } from "./guards";

const now = new Date("2026-10-21T15:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function eventFor(role: string, { createdAt = minutesAgo(1), banned = false } = {}) {
  return {
    locals: {
      session: { id: "s1", userId: "u1", createdAt },
      user: { id: "u1", role, banned },
    },
  };
}

const signedOut = { locals: { session: null, user: null } };

function failureOf(run: () => unknown) {
  try {
    run();
  } catch (thrown) {
    if (isHttpError(thrown)) return thrown;
    throw thrown;
  }
  throw new Error("expected the guard to throw");
}

describe("requireUser", () => {
  it("returns the session user", () => {
    expect(requireUser(eventFor("client")).user.id).toBe("u1");
  });

  it("answers 401 AUTH_REQUIRED without a session", () => {
    const failure = failureOf(() => requireUser(signedOut));
    expect(failure.status).toBe(401);
    expect(failure.body).toMatchObject({
      message: "Inicia sesión para continuar.",
      code: "AUTH_REQUIRED",
    });
  });

  it("answers 403 for a banned user even with a session", () => {
    const failure = failureOf(() => requireUser(eventFor("client", { banned: true })));
    expect(failure.status).toBe(403);
    expect(failure.body.code).toBe("FORBIDDEN");
  });
});

describe("requireAdmin", () => {
  it("lets an admin through", () => {
    expect(requireAdmin(eventFor("admin")).user.role).toBe("admin");
  });

  it("answers 403 to a client hitting an admin route", () => {
    expect(failureOf(() => requireAdmin(eventFor("client"))).status).toBe(403);
  });

  it("answers 403 to a banned admin and 401 to nobody", () => {
    expect(failureOf(() => requireAdmin(eventFor("admin", { banned: true }))).status).toBe(403);
    expect(failureOf(() => requireAdmin(signedOut)).status).toBe(401);
  });
});

describe("requireFreshSession", () => {
  it("accepts a session younger than ten minutes", () => {
    expect(() => requireFreshSession(eventFor("admin"), freshSessionMaxAgeMs, now)).not.toThrow();
  });

  it("requires re-authentication at exactly ten minutes and beyond", () => {
    for (const age of [10, 45]) {
      const failure = failureOf(() =>
        requireFreshSession(eventFor("admin", { createdAt: minutesAgo(age) }), undefined, now),
      );
      expect(failure.status).toBe(401);
      expect(failure.body.code).toBe("REAUTH_REQUIRED");
    }
  });

  it("treats a createdAt in the future as not fresh", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(
      failureOf(() => requireFreshSession(eventFor("admin", { createdAt: future }), undefined, now))
        .status,
    ).toBe(401);
  });

  it("checks identity before age", () => {
    expect(failureOf(() => requireFreshSession(signedOut)).body.code).toBe("AUTH_REQUIRED");
  });
});

describe("decode", () => {
  const Form = Schema.Struct({ sizeUsd: Schema.Number });

  it("returns the decoded value", () => {
    expect(decode(Form, { sizeUsd: 500 })).toEqual({ sizeUsd: 500 });
  });

  it("rejects unknown fields such as a user id in the body", () => {
    const failure = failureOf(() => decode(Form, { sizeUsd: 500, userId: "someone-else" }));
    expect(failure.status).toBe(400);
    expect(failure.body.code).toBe("INVALID_INPUT");
  });

  it("does not echo submitted values in the error", () => {
    const failure = failureOf(() => decode(Form, { sizeUsd: "hunter2-secret" }));
    expect(JSON.stringify(failure.body)).not.toContain("hunter2");
  });
});

describe("engineFor", () => {
  const namespace = { getByName: (name: string) => ({ name }) };

  it("addresses the Durable Object by the session user id only", () => {
    // A client-supplied id anywhere on the event must not matter.
    const event = { ...eventFor("client"), params: { userId: "victim" } };
    expect(engineFor(namespace, event)).toEqual({ name: "u1" });
  });

  it("refuses without a session", () => {
    expect(failureOf(() => engineFor(namespace, signedOut)).status).toBe(401);
  });
});

describe("engineForClient", () => {
  const namespace = { getByName: (name: string) => ({ name }) };

  it("gives an admin the stub of the named client", () => {
    expect(engineForClient(namespace, eventFor("admin"), "client-9")).toEqual({ name: "client-9" });
  });

  it("refuses a client (403), a banned admin (403) and no session (401)", () => {
    expect(failureOf(() => engineForClient(namespace, eventFor("client"), "u1")).status).toBe(403);
    expect(
      failureOf(() => engineForClient(namespace, eventFor("admin", { banned: true }), "x")).status,
    ).toBe(403);
    expect(failureOf(() => engineForClient(namespace, signedOut, "x")).status).toBe(401);
  });
});
