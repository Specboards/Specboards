import { authorizeCardsWrite } from "@/lib/api/cards-scope";
import {
  parseLevelTemplatesUpdate,
  updateLevelTemplates,
} from "@/lib/levels-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { LevelError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/levels/templates — assign a default detail template per
 * hierarchy level (Settings -> Cards). Body: { templates: { [levelKey]:
 * uuid | null }, productId? }; null clears the assignment. With a productId
 * the assignment is that product's, and it may only name a template that
 * product can see (its own set, or the workspace default's).
 */
export async function PUT(req: Request) {
  const authz = await authorizeCardsWrite(req);
  if (!authz.ok) return authz.response;
  const { scope, productId, body } = authz;

  try {
    const levels = await updateLevelTemplates(
      parseLevelTemplatesUpdate(body),
      scope,
      productId,
    );
    revalidateCardPages();
    return Response.json({ levels });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof LevelError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
