import { authorizeWrite } from "@/lib/auth-session";
import { promoteIdea } from "@/lib/ideas-service";
import { revalidateIdeaPages } from "@/lib/revalidate-cards";
import { IdeaError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/ideas/:id/promote - promote an idea into a DB-native feature at
 * the planning altitude, link the two, and advance the idea's status. Requires
 * write access to the idea's product.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    const result = await promoteIdea(id, authz.scope ?? undefined);
    revalidateIdeaPages();
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof IdeaError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
