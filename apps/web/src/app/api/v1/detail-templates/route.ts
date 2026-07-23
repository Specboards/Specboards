import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  createDetailTemplate,
  listDetailTemplates,
  parseDetailTemplateInput,
} from "@/lib/features-service";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { DetailTemplateError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** GET /api/v1/detail-templates — the workspace's detail templates. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const templates = await listDetailTemplates(authz.scope ?? undefined);
  return Response.json({ templates });
}

/**
 * POST /api/v1/detail-templates — create a detail template (Settings ->
 * Cards). Body: { name, body? }. Admin-only; local file mode is ungated.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const template = await createDetailTemplate(
      parseDetailTemplateInput(body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ template }, { status: 201 });
  } catch (err) {
    if (
      err instanceof InvalidPatchError ||
      err instanceof DetailTemplateError
    ) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
