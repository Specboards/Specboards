import { authorizeModelProviderAdmin } from "../guard";
import { getDb } from "@/lib/db";
import { summarizeUsage } from "@/lib/usage-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/model-provider/usage - what this workspace has spent through
 * Specboards at its own model provider this month, by feature and by person.
 *
 * ── Why it lives under `model-provider` ─────────────────────────────────────
 * Not tidiness: scopes are derived from the first path segment under `/api/v1`
 * (`lib/api-scopes.ts`), so a top-level `/usage` would be a new grantable
 * resource. Reading what the workspace spent, and configuring where it spends
 * it, are the same administrative concern over the same connection, and giving
 * them separate grants would invite a key that can read spend without being
 * able to see what it was spent on.
 *
 * ── Why org-admin and not member ────────────────────────────────────────────
 * The per-person breakdown is management information. The RLS policies
 * deliberately allow any member to read the ledger, because the cap check runs
 * inside an ordinary member's request and has to; this route is where "who
 * spent what" is gated, which is the only place that distinction can be made
 * without either breaking enforcement or granting a privilege escalation to the
 * service.
 */

const NO_DB = Response.json(
  {
    error: "Usage accounting requires a database (unavailable in local file mode).",
  },
  { status: 501 },
);

export async function GET(req: Request) {
  const authz = await authorizeModelProviderAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  return Response.json(await summarizeUsage(db, authz.scope.workspaceId));
}
