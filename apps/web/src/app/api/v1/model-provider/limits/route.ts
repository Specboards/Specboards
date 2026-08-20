import { readJsonBody } from "@/lib/api/body";
import { authorizeModelProviderAdmin } from "../guard";
import { getAppDb } from "@/lib/db";
import {
  getUsageLimits,
  saveUsageLimits,
  UsageLimitInputError,
} from "@/lib/usage-service";

export const dynamic = "force-dynamic";

/**
 * The spend caps on this workspace's model connection.
 *
 * Org-admin for reading as well as writing, even though RLS lets any member
 * read the row (the cap check needs to). A member has no use for the numbers
 * beyond the message they get when one is hit, and that message already carries
 * them.
 *
 * A separate resource from `/usage` because they are separate verbs on separate
 * things: one is a record of what happened, the other is a setting. Both sit
 * under `model-provider` so neither becomes its own grantable API scope; see the
 * note on the usage route.
 */

const NO_DB = Response.json(
  {
    error: "Spend caps require a database (unavailable in local file mode).",
  },
  { status: 501 },
);

export async function GET(req: Request) {
  const authz = await authorizeModelProviderAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  return Response.json(await getUsageLimits(db, authz.scope));
}

/**
 * PUT /api/v1/model-provider/limits - body `{ monthlyTokenCap, dailyUserTokenCap }`.
 *
 * Either may be `null` (or omitted, or an empty string, which is what a cleared
 * form field sends) to mean "no cap". PUT rather than PATCH deliberately: the
 * body is the whole policy, so clearing a field clears that cap rather than
 * leaving it at whatever it was, and there is no way to half-save a pair of
 * caps that are meant to be read together.
 */
export async function PUT(req: Request) {
  const authz = await authorizeModelProviderAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  try {
    return Response.json(
      await saveUsageLimits(db, authz.scope, {
        monthlyTokenCap: body.monthlyTokenCap as number | string | null,
        dailyUserTokenCap: body.dailyUserTokenCap as number | string | null,
      }),
    );
  } catch (err) {
    if (err instanceof UsageLimitInputError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
