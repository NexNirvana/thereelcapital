import { env } from "cloudflare:workers";
import { AuditQuery, auditFiltersOf, readAudit } from "#lib/server/admin-audit.ts";
import { decode } from "#lib/server/decode.ts";
import { requireAdmin } from "#lib/server/guards.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  requireAdmin(event);
  event.setHeaders({ "cache-control": "no-store" });

  const query = decode(AuditQuery, Object.fromEntries(event.url.searchParams));
  const filters = auditFiltersOf(query);
  const page = await readAudit(env.DB, filters, query.despues);
  const next = new URLSearchParams(
    Object.entries({ ...filters, despues: page.nextCursor ?? "" }).filter(
      ([, value]) => value !== "",
    ),
  );
  return {
    filters,
    filtered: Object.values(filters).some((value) => value !== ""),
    page,
    first: query.despues === undefined,
    nextQuery: page.nextCursor === null ? null : next.toString(),
  };
};
