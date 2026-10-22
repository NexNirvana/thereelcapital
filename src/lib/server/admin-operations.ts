// Fan-out over the clients' Durable Objects for the admin screens (docs/decisions.md T11: no read
// model). One slow or failing object must not block the page or hide its client, so every call has
// its own timeout and a failure becomes "unavailable" for that client alone.
import { ADMIN_FANOUT_TIMEOUT_MS } from "#lib/domain/config.ts";
import type { ClientOverview } from "#lib/domain/overview.ts";

export type Fetched<T> =
  { readonly status: "ok"; readonly value: T } | { readonly status: "unavailable" };

type EngineAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** Runs one engine call; a rejection, an engine error or a timeout all read as "unavailable". */
export async function settled<T>(
  call: () => Promise<EngineAnswer<T>>,
  timeoutMs = ADMIN_FANOUT_TIMEOUT_MS,
): Promise<Fetched<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const answer = await Promise.race([call().catch(() => null), timeout]);
    return answer?.ok ? { status: "ok", value: answer.value } : { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export interface OverviewEngine {
  overview(input: unknown): Promise<EngineAnswer<ClientOverview>>;
}

export interface ClientRef {
  readonly id: string;
  readonly email: string;
}

/** Every client's overview in parallel, in the order of `clients`. */
export function fetchOverviews(
  clients: readonly ClientRef[],
  engineOf: (clientId: string) => OverviewEngine,
  timeoutMs?: number,
): Promise<ReadonlyArray<ClientRef & { readonly overview: Fetched<ClientOverview> }>> {
  return Promise.all(
    clients.map(async (client) => ({
      ...client,
      overview: await settled(() => engineOf(client.id).overview({ mode: "SIM" }), timeoutMs),
    })),
  );
}
