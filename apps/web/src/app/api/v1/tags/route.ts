import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/service-errors";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { createTag, listTags } from "@/lib/tags-service";
import { TagError } from "@specboards/core";

export const dynamic = "force-dynamic";

/** GET /api/v1/tags — the workspace's tag registry, in display order. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const tags = await listTags(authz.scope ?? undefined);
  return Response.json({ tags });
}

/**
 * POST /api/v1/tags — add a tag to the registry. Body: { name }.
 *
 * Any member who can write may create a tag, deliberately unlike
 * `/api/v1/properties` which is admin-only. Adding a tag from a card when it
 * does not exist yet is the point of the feature, and someone who can already
 * put arbitrary text on an item gains nothing from being refused the row that
 * names it. Renaming and deleting are the destructive operations and stay
 * admin-only, on `/api/v1/tags/:id`.
 *
 * Creating a name that already exists is a 422 rather than a quiet success: the
 * item write path creates tags implicitly and idempotently, so an explicit
 * request to create one is somebody asking, and they should hear the answer.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

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
    const tag = await createTag(name, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json({ tag }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof TagError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
