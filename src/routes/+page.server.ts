import { env } from "cloudflare:workers";

export async function load() {
  const ping = await env.ENGINE.getByName("smoke").ping();
  return { ping };
}
