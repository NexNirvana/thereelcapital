import { DurableObject } from "cloudflare:workers";
import { migrate } from "./schema.ts";

export class ClientCoordinator extends DurableObject<EngineEnv> {
  constructor(ctx: DurableObjectState, env: EngineEnv) {
    super(ctx, env);
    // Built before the first request is served, so every RPC sees the full schema.
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  ping(): string {
    return "pong";
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<EngineEnv>;
