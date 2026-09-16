import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import { getAppDb } from "@/lib/db";
import {
  createSchedule,
  listScheduleViews,
  ScheduleInputError,
} from "@/lib/schedules-service";

export const dynamic = "force-dynamic";

/**
 * The parsed body as a bag of unknowns.
 *
 * The service validates every field itself, so this only has to stop a JSON
 * literal (a string, a number, `null`) reaching a function that expects to be
 * able to read properties off it.
 */
function asObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : {};
}

/** Schedules need a database and a running server; local file mode has neither. */
const NO_DB = Response.json(
  { error: "Schedules require a database (unavailable in local file mode)." },
  { status: 501 },
);

/**
 * GET /api/v1/schedules - the workspace's schedules.
 *
 * Any member may read. The rows are visible through row-level security anyway
 * (migration 0019 resolves the target's product), so gating the read here as
 * well would be a second copy of a rule the database already enforces, and the
 * two would drift.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  return Response.json({ schedules: await listScheduleViews(db, authz.scope) });
}

/**
 * POST /api/v1/schedules - create one. Admin-only.
 *
 * Stricter than reading, and stricter than opening a run, because creating a
 * schedule commits the workspace to spending its inference budget every week
 * from now on with nobody present at the moment it spends. That is an
 * administrative decision, and it matches the gate on the skills it runs.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const schedule = await createSchedule(db, authz.scope, asObject(parsed.body));
    return Response.json({ schedule }, { status: 201 });
  } catch (err) {
    if (err instanceof ScheduleInputError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
