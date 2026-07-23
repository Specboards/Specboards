import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import { FeatureNotFoundError } from "@/lib/features-service";
import {
  GithubNotConfiguredError,
  InvalidGithubLinkError,
  addFeatureGithubLink,
  parseGithubLinkInput,
} from "@/lib/github-links-service";
import { getStore } from "@/lib/store";
import { RelationError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/** GET /api/v1/features/:specId/github-links — a feature's GitHub links. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const store = await getStore();
  const feature = await store.getFeature(specId, authz.scope ?? undefined);
  if (!feature) {
    return Response.json(
      { error: `Unknown feature: ${specId}` },
      { status: 404 },
    );
  }
  return Response.json({ githubLinks: feature.githubLinks });
}

/**
 * POST /api/v1/features/:specId/github-links — link a GitHub artifact
 * ({ kind, number? | branch? }). Resolves its metadata from GitHub, persists,
 * and returns the feature's refreshed link list.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const githubLinks = await addFeatureGithubLink(
      specId,
      parseGithubLinkInput(body),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"])
      revalidatePath(path, "page");
    revalidatePath("/[org]/[product]/backlog/[...slug]", "page");
    return Response.json({ githubLinks });
  } catch (err) {
    if (err instanceof FeatureNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof GithubNotConfiguredError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidGithubLinkError || err instanceof RelationError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
