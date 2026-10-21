// The admin client list and client creation (docs/screens-and-flows.md#admin). The admin is always
// the session user from the guards; the only request value used is the new client's email.
import { isHttpError } from "@sveltejs/kit";
import { Schema } from "effect";
import { activationUrl } from "./activation-link.ts";
import { createClient, type ActivationDb, type ActivationStatement } from "./activation.ts";
import {
  guardErrors,
  requireAdmin,
  requireFreshSession,
  type GuardEvent,
  type GuardLocals,
} from "./guards.ts";

// The slice of D1 the list reads; D1Database satisfies it.
export interface ClientListDb {
  prepare(sql: string): { bind(): { all(): Promise<{ results: unknown[] }> } };
}

const ClientRow = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  access: Schema.Literals(["invited", "active", "disabled"]),
  hasConnection: Schema.Literals([0, 1]),
});
export type ClientRow = typeof ClientRow.Type;

/** Every client (role `user`; admins are not clients), newest first. Computed in SQL, once. */
export async function listClients(db: ClientListDb): Promise<readonly ClientRow[]> {
  const { results } = await db
    .prepare(
      `SELECT u."id" AS id, u."email" AS email,
         CASE WHEN u."banned" = 1 THEN 'disabled'
              WHEN EXISTS (SELECT 1 FROM "passkey" p WHERE p."userId" = u."id") THEN 'active'
              ELSE 'invited' END AS access,
         EXISTS (SELECT 1 FROM broker_connection b WHERE b.user_id = u."id") AS hasConnection
       FROM "user" u
       WHERE u."role" = 'user'
       ORDER BY u."createdAt" DESC, u."email"`,
    )
    .bind()
    .all();
  return Schema.decodeUnknownSync(Schema.Array(ClientRow))(results);
}

// Stable codes with the Spanish text the screen shows; internal detail never reaches the response.
export const clientErrors = {
  invalidEmail: { status: 400, code: "INVALID_EMAIL", message: "Escribe un correo válido." },
  emailTaken: {
    status: 409,
    code: "EMAIL_TAKEN",
    message: "Ya existe un cliente con ese correo.",
  },
  createFailed: {
    status: 500,
    code: "CREATE_FAILED",
    message: "No pudimos crear el cliente. Inténtalo de nuevo.",
  },
} as const;

type Failure = (typeof clientErrors)[keyof typeof clientErrors] | typeof guardErrors.reauthRequired;

export type CreateClientResult =
  { ok: true; email: string; link: string; expiresAt: number } | { ok: false; error: Failure };

// Unknown fields are rejected; the address is normalised before it is checked or stored.
const NewClientForm = Schema.Struct({
  email: Schema.String.check(
    Schema.isMaxLength(254),
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  ),
});

export interface CreateClientEnv<S extends ActivationStatement> {
  db: ActivationDb<S> & ClientListDb;
  origin: string;
  createUser: (email: string) => Promise<{ id: string }>;
}

async function emailTaken<S extends ActivationStatement>(db: ActivationDb<S>, email: string) {
  const row = await db
    .prepare(`SELECT 1 AS found FROM "user" WHERE "email" = ?`)
    .bind(email)
    .first();
  return row !== null;
}

/**
 * Creates a client for the admin form. Admin and a session under 10 minutes old are required
 * (the first throws 401/403, the second becomes a result the screen can offer re-auth for); the
 * activation link is returned here and nowhere else, so it is shown once.
 */
export async function createClientFromForm<L extends GuardLocals, S extends ActivationStatement>(
  event: GuardEvent<L>,
  env: CreateClientEnv<S>,
  form: unknown,
  now = Date.now(),
): Promise<CreateClientResult> {
  const actor = requireAdmin(event);
  try {
    requireFreshSession(event, undefined, new Date(now));
  } catch (failure) {
    if (isHttpError(failure) && failure.status === guardErrors.reauthRequired.status) {
      return { ok: false, error: guardErrors.reauthRequired };
    }
    throw failure;
  }

  const decoded = Schema.decodeUnknownResult(NewClientForm, { onExcessProperty: "error" })(form);
  if (decoded._tag === "Failure") return { ok: false, error: clientErrors.invalidEmail };
  const email = decoded.success.email.toLowerCase();

  if (await emailTaken(env.db, email)) return { ok: false, error: clientErrors.emailTaken };
  try {
    const issued = await createClient(
      { db: env.db, createUser: env.createUser },
      actor,
      email,
      now,
    );
    return {
      ok: true,
      email,
      link: activationUrl(env.origin, issued.token),
      expiresAt: issued.expiresAt,
    };
  } catch (failure) {
    // Two admins creating the same address at once: the loser sees the duplicate message.
    if (await emailTaken(env.db, email)) return { ok: false, error: clientErrors.emailTaken };
    console.error("client.create failed", failure instanceof Error ? failure.name : "unknown");
    return { ok: false, error: clientErrors.createFailed };
  }
}
