// Fan-out over the clients' Durable Objects for the admin screens (docs/decisions.md T11: no read
// model). One slow or failing object must not block the page or hide its client, so every call has
// its own timeout and a failure becomes "unavailable" for that client alone.
import { ADMIN_FANOUT_TIMEOUT_MS } from "#lib/domain/config.ts";
import type { ClientOverview } from "#lib/domain/overview.ts";

export type Fetched<T> =
  { readonly status: "ok"; readonly value: T } | { readonly status: "unavailable" };

type EngineAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** Runs one engine call; a rejection (or a synchronous throw) or a timeout reads as null. */
export async function withTimeout<T>(
  call: () => Promise<T>,
  timeoutMs = ADMIN_FANOUT_TIMEOUT_MS,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(call)
        .catch(() => null),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one engine call; a rejection, an engine error or a timeout all read as "unavailable". */
export async function settled<T>(
  call: () => Promise<EngineAnswer<T>>,
  timeoutMs?: number,
): Promise<Fetched<T>> {
  const answer = await withTimeout(call, timeoutMs);
  return answer?.ok ? { status: "ok", value: answer.value } : { status: "unavailable" };
}

export interface OverviewEngine {
  overview(input: unknown): Promise<EngineAnswer<ClientOverview>>;
}

export interface ClientRef {
  readonly id: string;
  readonly email: string;
}

/**
 * Starts every client's overview at once and returns the rows at once, each with its own promise
 * (never rejecting: a failure or a timeout settles as "unavailable"). The page streams them, so
 * the slowest object delays only its own row.
 */
export function startOverviews(
  clients: readonly ClientRef[],
  engineOf: (clientId: string) => OverviewEngine,
  timeoutMs?: number,
): ReadonlyArray<ClientRef & { readonly overview: Promise<Fetched<ClientOverview>> }> {
  return clients.map((client) => ({
    ...client,
    overview: settled(() => engineOf(client.id).overview({ mode: "SIM" }), timeoutMs),
  }));
}
