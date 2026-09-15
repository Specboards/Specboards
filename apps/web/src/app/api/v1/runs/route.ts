import { resolveReadScope } from "@/lib/auth-session";
import { getAppDb } from "@/lib/db";
import { listRunsForItem } from "@/lib/runs/service";
import { RunInputError } from "@/lib/runs/types";

export const dynamic = "force-dynamic";

const NO_DB = Response.json(
  { error: "Agent runs require a database (unavailable in local file mode)." },
  { status: 501 },
);

/**
 * GET /api/v1/runs?specId=... - every run against one item, newest first.
 *
 * Scoped by `specId` rather than listing the workspace: a run is read in the
 * context of the thing it is working on, which is where the card shows it.
 * A workspace-wide view belongs with the review inbox, where runs and
 * proposals are read together.
 *
 * `runs:read` (derived from the path). Deliberately weaker than the
 * `features:read` a caller needs to see the item itself, which is the right
 * way round: the RLS policy resolves the run's real target and refuses a row
 * whose item the caller cannot see, so this grant cannot be used to learn
 * about work on items that are not visible.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  const specId = new URL(req.url).searchParams.get("specId");
  if (!specId) {
    return Response.json(
      { error: "specId is required." },
      { status: 422 },
    );
  }

  try {
    return Response.json({ runs: await listRunsForItem(db, authz.scope, specId) });
  } catch (err) {
    if (err instanceof RunInputError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
