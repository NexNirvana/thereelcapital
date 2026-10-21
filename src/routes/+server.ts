import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import type { RequestHandler } from "./$types";

// docs/screens-and-flows.md: Operar lives at /operar; the root only points there.
export const GET: RequestHandler = () => redirect(303, resolve("/(app)/operar"));
