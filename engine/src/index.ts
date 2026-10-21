import { DurableObject } from "cloudflare:workers";

export class ClientCoordinator extends DurableObject<EngineEnv> {
  ping(): string {
    return "pong";
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<EngineEnv>;
