import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import { getAppDb } from "@/lib/db";
import { cancelRun, steerRun } from "@/lib/runs/service";
import { parseSteer, RunInputError } from "@/lib/runs/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const NO_DB = Response.json(
  { error: "Agent runs require a database (unavailable in local file mode)." },
  { status: 501 },
);

/**
 * PATCH /api/v1/runs/:id - the two things a person can do to a run in flight.
 *
 * Body is `{ cancel: true }` or `{ steer: "..." }`, one or the other.
 *
 * ── What cancelling actually does ─────────────────────────────────────────
 * It marks the run stopped and tells the agent the next time it reports. We
 * have no channel to a connected agent and are not opening one, so stopping
 * is cooperative: a well-behaved agent winds up, and a badly behaved one can
 * carry on using the ordinary tool surface. The honest framing for the UI is
 * "ask it to stop", not "kill it". What the button does guarantee is that the
 * run's record stops here, and that anything the agent proposes afterwards
 * still has to be applied by a person.
 *
 * Cancelling a run that already finished is not an error: the caller wanted
 * it stopped and it is stopped. It comes back `alreadyFinished` so a UI can
 * say so rather than claiming to have done something.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  const wantsCancel = body.cancel === true;
  const note = parseSteer(body.steer);
  if (wantsCancel === (note !== null)) {
    return Response.json(
      { error: 'Send either { cancel: true } or { steer: "..." }.' },
      { status: 422 },
    );
  }

  try {
    if (wantsCancel) {
      const run = await cancelRun(db, authz.scope, id);
      return run
        ? Response.json({ run })
        : Response.json({ run: null, alreadyFinished: true });
    }
    return Response.json({ run: await steerRun(db, authz.scope, id, note!) });
  } catch (err) {
    if (err instanceof RunInputError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
