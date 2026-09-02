import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { InvalidPatchError } from "@/lib/service-errors";
import { parseSpecContentInput } from "@/lib/specs-service";
import {
  SpecConflictError,
  SpecContentError,
  updateSpecContent,
} from "@/lib/spec-content";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/**
 * PUT /api/v1/features/:specId/content — replace a spec's Markdown body and
 * commit it to the connected repo. Body: `{ content, message? }`, where
 * `content` is the Markdown *after* the frontmatter (the shape `GET
 * /features/:specId` returns). The frontmatter, and so the stable `id`, is
 * preserved by the write.
 *
 * Where the change lands depends on the repo's write mode. The response carries
 * `spec.pullRequest` when it was proposed for review instead of committed to the
 * default branch, and its absence is how a client knows the text is live.
 *
 * This is the browser's way into `updateSpecContent`, which until now was
 * reachable only over MCP. Authorization is deliberately not repeated here:
 * that function checks read access through the RLS-scoped store and then makes
 * an explicit product-write check, because the git write itself runs on the
 * owner connection. Duplicating the check here would be two places to keep in
 * step; weakening it would hand an editor a path to specs their role cannot
 * touch. This route establishes the session and hands off.
 */
export async function PUT(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  let input;
  try {
    input = parseSpecContentInput(body);
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  // A spec write is a commit to a connected GitHub repo, so it needs the
  // database-backed deployment. Local file mode has neither the repo record nor
  // a scope to authorize against; say so rather than failing obscurely.
  const db = getDb();
  if (!db || !authz.scope) {
    return Response.json(
      {
        error:
          "Editing spec content needs a database-backed deployment with a " +
          "connected GitHub repository; it is unavailable in local file mode.",
      },
      { status: 422 },
    );
  }

  try {
    const result = await updateSpecContent(
      db,
      authz.scope,
      specId,
      input.content,
      { message: input.message, expectedBlobSha: input.expectedBlobSha },
    );
    // A direct write re-syncs the repo, so the item's cached body has already
    // changed by the time this returns; drop the pages that render it. A change
    // proposed as a pull request has not touched the default branch, so there is
    // nothing yet to re-read: throwing the cache away would only make every
    // reader refetch the same text they already have.
    if (!result.pullRequest) {
      revalidatePath("/[org]/[product]/backlog/[...slug]", "page");
      for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"])
        revalidatePath(path, "page");
    }
    return Response.json({ spec: result });
  } catch (err) {
    // A conflict is 409 rather than 422 because it is not a bad request: the
    // author did nothing wrong and the same body sent a moment earlier would
    // have worked. The version that won comes back with it so the editor can
    // show what happened instead of an apology, and its sha is what a
    // deliberate overwrite sends next.
    if (err instanceof SpecConflictError) {
      return Response.json(
        {
          error: err.message,
          conflict: {
            path: err.path,
            currentContent: err.currentContent,
            currentBlobSha: err.currentBlobSha,
            sections: err.sections,
          },
        },
        { status: 409 },
      );
    }
    // SpecContentError messages are already written for a human ("This spec has
    // no connected repository file to edit", "Your role does not permit editing
    // this spec"), so they go through to the UI unchanged.
    if (err instanceof SpecContentError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
