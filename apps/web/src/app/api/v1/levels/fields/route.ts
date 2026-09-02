import { revalidatePath } from "next/cache";

import { authorizeCardsWrite } from "@/lib/api/cards-scope";
import {
  parseLevelFieldsUpdate,
  updateLevelFields,
} from "@/lib/levels-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { LevelError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/levels/fields — set which metadata fields are available per
 * hierarchy level (Settings → Cards). Body: { fields: { [levelKey]:
 * string[] | null }, productId? }; null = every field.
 *
 * The hierarchy itself stays workspace-wide (that is PUT /api/v1/levels); this
 * only changes what each level shows. With a productId the change is that
 * product's, and it is a patch on the levels named: levels left out go on
 * inheriting, which is what stops a newly added level from silently narrowing.
 */
export async function PUT(req: Request) {
  const authz = await authorizeCardsWrite(req);
  if (!authz.ok) return authz.response;
  const { scope, productId, body } = authz;

  try {
    const levels = await updateLevelFields(
      parseLevelFieldsUpdate(body),
      scope,
      productId,
    );
    for (const path of [
      "/[org]/[product]/backlog",
      "/[org]/settings/work-cards",
    ])
      revalidatePath(path, "page");
    return Response.json({ levels });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof LevelError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
