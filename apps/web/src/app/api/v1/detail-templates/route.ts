import {
  authorizeCardsWrite,
  readCardsProductId,
} from "@/lib/api/cards-scope";
import { resolveReadScope } from "@/lib/auth-session";
import {
  createDetailTemplate,
  listDetailTemplates,
  parseDetailTemplateInput,
} from "@/lib/detail-templates-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { DetailTemplateError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/detail-templates — the detail templates in force. `?productId=`
 * resolves one product's; without it you get the workspace default's.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const templates = await listDetailTemplates(
    authz.scope ?? undefined,
    readCardsProductId(req),
  );
  return Response.json({ templates });
}

/**
 * POST /api/v1/detail-templates — create a detail template (Settings ->
 * Cards). Body: { name, body?, productId? }. With a productId the template
 * belongs to that product; without one it belongs to the workspace default.
 */
export async function POST(req: Request) {
  const authz = await authorizeCardsWrite(req);
  if (!authz.ok) return authz.response;
  const { scope, productId, body } = authz;

  try {
    const template = await createDetailTemplate(
      parseDetailTemplateInput(body),
      scope,
      productId,
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
