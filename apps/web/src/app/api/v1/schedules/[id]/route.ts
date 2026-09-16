import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getAppDb } from "@/lib/db";
import {
  removeSchedule,
  ScheduleInputError,
  updateSchedule,
} from "@/lib/schedules-service";

export const dynamic = "force-dynamic";

const NO_DB = Response.json(
  { error: "Schedules require a database (unavailable in local file mode)." },
  { status: 501 },
);

const NOT_FOUND = Response.json({ error: "No such schedule." }, { status: 404 });

/** The parsed body as a bag of unknowns; the service validates each field. */
function asObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : {};
}

/** PATCH /api/v1/schedules/:id - edit one. Admin-only. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const { id } = await params;

  try {
    const schedule = await updateSchedule(db, authz.scope, id, asObject(parsed.body));
    return schedule ? Response.json({ schedule }) : NOT_FOUND;
  } catch (err) {
    if (err instanceof ScheduleInputError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

/** DELETE /api/v1/schedules/:id - remove one. Admin-only. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  const { id } = await params;
  return (await removeSchedule(db, authz.scope, id))
    ? new Response(null, { status: 204 })
    : NOT_FOUND;
}
