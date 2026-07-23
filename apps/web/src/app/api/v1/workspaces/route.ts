import { readJsonBody } from "@/lib/api/body";
import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { seedSampleData } from "@/lib/sample-data";
import {
  createWorkspaceWithOwner,
  getMembership,
  getMembershipFor,
  WorkspaceSlugError,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";

const NAME_MAX = 80;

/**
 * POST /api/v1/workspaces — create the organization. Used by /setup for the
 * first user, who becomes its `admin`. If an org already exists, the caller is
 * joined to it rather than creating a second (see `createWorkspaceWithOwner`).
 */
export async function POST(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  // A user who already belongs to a workspace can't create another.
  const existing = await getMembership(db, user.id);
  if (existing) {
    return Response.json(
      { error: "You already belong to a workspace." },
      { status: 409 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const rawBody = (body ?? {}) as {
    name?: unknown;
    slug?: unknown;
    seedSampleData?: unknown;
  };
  const name = typeof rawBody.name === "string" ? rawBody.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return Response.json(
      { error: `Organization name is required (max ${NAME_MAX} characters).` },
      { status: 422 },
    );
  }
  // An explicit slug is optional — the user only sets one to override the slug
  // auto-derived from the name (e.g. after a collision warning).
  const slug =
    typeof rawBody.slug === "string" ? rawBody.slug.trim() : undefined;
  const wantsSampleData = rawBody.seedSampleData === true;

  let workspace;
  try {
    workspace = await createWorkspaceWithOwner(db, name, user.id, { slug });
  } catch (err) {
    if (err instanceof WorkspaceSlugError) {
      return Response.json(
        { error: err.message, code: err.code, suggestion: err.suggestion },
        { status: err.code === "slug_taken" ? 409 : 422 },
      );
    }
    throw err;
  }

  // Only seed when this user actually created the org (became admin) — a
  // concurrent setup could have joined them to an existing one as a viewer.
  let seeded = 0;
  if (wantsSampleData) {
    const membership = await getMembershipFor(db, user.id, workspace.id);
    if (membership?.role === "owner") {
      seeded = await seedSampleData(db, workspace.id);
    }
  }

  return Response.json({ workspace, seeded }, { status: 201 });
}
