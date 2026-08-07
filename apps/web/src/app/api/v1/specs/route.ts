import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  InvalidPatchError,
  parseSpecCreateInput,
  patchFeature,
} from "@/lib/features-service";
import { SpecContentError, createSpec } from "@/lib/spec-content";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/specs — commit a new `specs/<slug>/spec.md` to a connected repo
 * and sync it onto the board. The browser's way into `createSpec`, which until
 * now was reachable only over MCP, so a PM could edit a spec in the app but not
 * bring one into existence.
 *
 * Two shapes, and the difference matters:
 *
 * - With `workItemId`, the spec **attaches** to a work item that already
 *   exists. The file carries that item's own id, so the sync links it to the
 *   row that is already there and the item keeps its status, assignee, parent,
 *   comments and history. This is the common case: work tracked as a card that
 *   now needs a document.
 * - With `parentSpecId` (or neither), a **new** spec is created with a fresh
 *   id and the sync brings a work item into being for it. `parentSpecId` then
 *   nests that item under the caller's card.
 *
 * The parenting is done here rather than left to the caller because the two
 * calls are one user action. A client that made them separately and then failed
 * (or was closed) between them would strand a spec at the top of the board
 * under an auto-created grouping, which is tedious to untangle by hand.
 *
 * Authorization is deliberately not repeated in this route. `createSpec` reads
 * through the RLS-scoped store and makes explicit product-write checks against
 * both the target repo's default product and the item being attached to,
 * because the git write itself runs on the owner connection. This route
 * establishes the session and hands off.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  let input;
  try {
    input = parseSpecCreateInput(parsed.body);
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  // Creating a spec is a commit to a connected GitHub repo, so it needs the
  // database-backed deployment. Local file mode has neither the repo record nor
  // a scope to authorize against; say so rather than failing obscurely.
  const db = getDb();
  if (!db || !authz.scope) {
    return Response.json(
      {
        error:
          "Creating specs needs a database-backed deployment with a " +
          "connected GitHub repository; it is unavailable in local file mode.",
      },
      { status: 422 },
    );
  }

  let spec;
  try {
    spec = await createSpec(db, authz.scope, {
      title: input.title,
      body: input.body,
      repoId: input.repoId,
      workItemId: input.workItemId,
      templateId: input.templateId,
      message: input.message,
    });
  } catch (err) {
    // SpecContentError messages are already written for a human ("specs/x/spec.md
    // already exists in owner/repo. Pick a different title."), so they go
    // through to the UI unchanged: that one is the rename prompt.
    if (err instanceof SpecContentError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  // The file is committed and synced by this point. If nesting then fails, the
  // spec genuinely exists, so reporting the whole request as an error would be
  // a lie that invites the user to create it a second time. Report success and
  // name what did not happen, so they can fix the one part that is wrong.
  let parentWarning: string | undefined;
  if (input.parentSpecId) {
    try {
      await patchFeature(
        spec.specId,
        { parentSpecId: input.parentSpecId },
        authz.scope,
      );
    } catch (err) {
      parentWarning =
        `${spec.path} was created, but nesting it under the parent failed: ` +
        `${err instanceof Error ? err.message : "unknown error"}. ` +
        "Set its parent from the item's Relationships section.";
      console.warn(`[specs] parenting ${spec.specId} failed:`, err);
    }
  }

  // The create re-synced the repo, so the board has already changed by the time
  // this returns; drop the pages that render it.
  revalidatePath("/[org]/[product]/backlog/[...slug]", "page");
  for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"])
    revalidatePath(path, "page");

  return Response.json(
    parentWarning ? { spec, parentWarning } : { spec },
    { status: 201 },
  );
}
