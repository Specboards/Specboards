import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/service-errors";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { deleteTag, renameTag } from "@/lib/tags-service";
import { TagError } from "@specboards/core";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/v1/tags/:id — rename a tag. Body: { name }.
 *
 * Admin-only, unlike creating one. A rename rewrites the tag on every item that
 * carries it, which is a change to other people's cards; adding a tag is not.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const name =
    typeof body === "object" && body !== null && "name" in body
      ? (body as { name: unknown }).name
      : undefined;
  if (typeof name !== "string") {
    return Response.json({ error: "name must be a string." }, { status: 422 });
  }

  try {
    const tag = await renameTag(id, name, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json({ tag });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof TagError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/**
 * DELETE /api/v1/tags/:id — drop a tag from the registry. Admin-only.
 *
 * Item values are left in place, the way dropping a custom property leaves its
 * values: re-adding the tag brings them back, and an admin tidying a settings
 * list must not silently delete other people's work.
 */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    await deleteTag(id, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof TagError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
