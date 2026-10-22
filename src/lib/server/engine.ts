import { requireAdmin, requireUser, type GuardEvent } from "./guards.ts";

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

/**
 * An admin's read-only way to a client's engine, for the overview screens: the Durable Object is
 * named after the client id, which the admin screens take from the D1 client list or a validated
 * URL, never from a body. Only an admin gets a stub (401/403 otherwise); the overview methods it
 * is used for never place or cancel an order.
 */
export function engineForClient<Stub>(
  namespace: { getByName(name: string): Stub },
  event: GuardEvent,
  clientId: string,
): Stub {
  requireAdmin(event);
  return namespace.getByName(clientId);
}
