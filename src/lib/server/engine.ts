import { requireUser, type GuardEvent } from "./guards.ts";

/**
 * The only way web code reaches a client's Durable Object: the name is the session user id, so a
 * client can never address another client's engine (docs/auth-and-security.md#isolation).
 * The namespace is a parameter because `cloudflare:workers` doesn't load in unit tests.
 */
export function engineFor<Stub>(
  namespace: { getByName(name: string): Stub },
  event: GuardEvent,
): Stub {
  return namespace.getByName(requireUser(event).user.id);
}
