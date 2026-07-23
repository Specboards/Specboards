import { and, eq, repositories } from "@specboards/db";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/repositories/:id — one connected repo in the caller's workspace. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  // Local file mode (auth disabled -> null scope) has no repos.
  if (!db || !authz.scope) {
    return Response.json({ error: "Repository not found." }, { status: 404 });
  }

  const { id } = await params;
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.id, id),
        eq(repositories.workspaceId, authz.scope.workspaceId),
      ),
    );
  if (!repo) {
    return Response.json({ error: "Repository not found." }, { status: 404 });
  }
  return Response.json({ repository: repo });
}

interface RepositoryPatch {
  defaultBranch?: string;
  specGlobs?: string[];
}

/**
 * Validate an untrusted repository patch: an optional `defaultBranch` and/or
 * `specGlobs` (which becomes the repo's spec-import config). Returns an error
 * string when the body is malformed or empty.
 */
function parseRepositoryPatch(body: unknown): RepositoryPatch | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  const raw = body as Record<string, unknown>;
  const patch: RepositoryPatch = {};

  if (raw.defaultBranch !== undefined) {
    if (
      typeof raw.defaultBranch !== "string" ||
      raw.defaultBranch.trim() === ""
    ) {
      return "defaultBranch must be a non-empty string.";
    }
    patch.defaultBranch = raw.defaultBranch.trim();
  }

  if (raw.specGlobs !== undefined) {
    if (
      !Array.isArray(raw.specGlobs) ||
      raw.specGlobs.some((g) => typeof g !== "string")
    ) {
      return "specGlobs must be an array of strings.";
    }
    patch.specGlobs = (raw.specGlobs as string[])
      .map((g) => g.trim())
      .filter(Boolean);
  }

  if (patch.defaultBranch === undefined && patch.specGlobs === undefined) {
    return "Provide at least one of defaultBranch or specGlobs to update.";
  }
  return patch;
}

/**
 * PATCH /api/v1/repositories/:id — update a connected repo's default branch
 * and/or spec-import globs. Admin-only, mirroring connect/disconnect (it
 * reshapes what gets imported from someone's source tree).
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!db || !authz.scope) {
    return Response.json(
      { error: "Repository management requires a database." },
      { status: 501 },
    );
  }

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = parseRepositoryPatch(parsedBody.body);
  if (typeof parsed === "string") {
    return Response.json({ error: parsed }, { status: 422 });
  }

  const set: Partial<typeof repositories.$inferInsert> = {};
  if (parsed.defaultBranch !== undefined)
    set.defaultBranch = parsed.defaultBranch;
  if (parsed.specGlobs !== undefined) {
    set.config = { version: 1, specGlobs: parsed.specGlobs };
  }

  const { id } = await params;
  const [repo] = await db
    .update(repositories)
    .set(set)
    .where(
      and(
        eq(repositories.id, id),
        eq(repositories.workspaceId, authz.scope.workspaceId),
      ),
    )
    .returning();
  if (!repo) {
    return Response.json({ error: "Repository not found." }, { status: 404 });
  }
  return Response.json({ repository: repo });
}

/**
 * DELETE /api/v1/repositories/:id — disconnect a connected repo. Admin-only,
 * mirroring connect (connecting wires automated commits into a source tree, so
 * disconnecting is the same blast radius). Detaches imported board items
 * (`features.repo_id` → NULL via the FK) and removes the repo's GitHub links;
 * the board content itself is preserved as standalone rows.
 */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  // Local file mode (auth disabled → null scope) has no repos to manage.
  if (!db || !authz.scope) {
    return Response.json(
      { error: "Repository management requires a database." },
      { status: 501 },
    );
  }

  const { id } = await params;
  const [deleted] = await db
    .delete(repositories)
    .where(
      and(
        eq(repositories.id, id),
        eq(repositories.workspaceId, authz.scope.workspaceId),
      ),
    )
    .returning();
  if (!deleted) {
    return Response.json({ error: "Repository not found." }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
