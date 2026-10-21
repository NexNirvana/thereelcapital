// Runs one BrokerAdapter operation exactly once and returns its typed failure as a value.

import { Effect } from "effect";
import type { BrokerError } from "./errors.ts";

export type Attempt<A> =
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: BrokerError };

export async function attempt<A>(effect: Effect.Effect<A, BrokerError>): Promise<Attempt<A>> {
  const result = await Effect.runPromise(Effect.result(effect));
  return result._tag === "Success"
    ? { ok: true, value: result.success }
    : { ok: false, error: result.failure };
}
