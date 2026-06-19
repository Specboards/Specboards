import { revalidatePath } from "next/cache";

import { authorizeWrite } from "@/lib/auth-session";
import { FeatureNotFoundError } from "@/lib/features-service";
import { removeFeatureGithubLink } from "@/lib/github-links-service";
import { RelationError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string; linkId: string }> };

/** DELETE /api/v1/features/:specId/github-links/:linkId — remove a link. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId, linkId } = await params;

  try {
    const githubLinks = await removeFeatureGithubLink(
      specId,
      decodeURIComponent(linkId),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"]) revalidatePath(path, "page");
    revalidatePath("/[org]/[product]/backlog/[specId]", "page");
    return Response.json({ githubLinks });
  } catch (err) {
    if (err instanceof FeatureNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RelationError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
