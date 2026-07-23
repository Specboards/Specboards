import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  getIdeaSettings,
  parseIdeaSettingsPatch,
  updateIdeaSettings,
} from "@/lib/features-service";

export const dynamic = "force-dynamic";

/** GET /api/v1/idea-settings - the workspace's Ideas configuration. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const settings = await getIdeaSettings(authz.scope ?? undefined);
  return Response.json({ settings });
}

/**
 * PATCH /api/v1/idea-settings - update the workspace's Ideas configuration
 * (public portal settings). Admin-only; local file mode is ungated.
 */
export async function PATCH(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const settings = await updateIdeaSettings(
      parseIdeaSettingsPatch(body),
      authz.scope ?? undefined,
    );
    revalidatePath("/[org]/settings/ideas", "page");
    return Response.json({ settings });
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
