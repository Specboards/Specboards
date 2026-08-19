import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import {
  acceptReleaseProposal,
  rejectReleaseProposal,
  ProposalForbiddenError,
  ProposalInvalidError,
  ProposalNotFoundError,
  ProposalSettledError,
  ProposalStaleError,
} from "@/lib/assistant-proposals";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Deciding about release notes the assistant proposed.
 *
 * ── Why this lives under `releases` and not under `assistant` ───────────────
 * Scopes are derived from the first path segment (`lib/api-scopes.ts`), and the
 * point of this endpoint is that accepting is a *change to the release*, not a
 * use of the assistant. Under `/assistant` a key granted `assistant:write`
 * could both draft the notes and publish them, which is the exact failure the
 * proposal mechanism exists to prevent, arriving as a side effect of turning the
 * assistant on. Here it needs `releases:write`: the same grant that lets a
 * caller type the notes by hand, which is what accepting is.
 *
 * The mirror of `/api/v1/features/{specId}/proposals`, deliberately, so the two
 * halves of "may draft" and "may publish" are the same two decisions on both
 * surfaces.
 */
const NO_DB = Response.json(
  {
    error: "Proposals require a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/**
 * POST /api/v1/releases/:id/proposals
 * Body: `{ messageId, action: "accept" | "reject", body? }`.
 *
 * `body` replaces what the assistant drafted, which is "edit before accepting":
 * the reviewer changed a line before saying yes, and what lands is their text.
 * It is still recorded as accepted, because the question the record answers is
 * whether a human decided, and they did.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const input = parsed.body as Record<string, unknown>;

  const messageId = typeof input.messageId === "string" ? input.messageId : "";
  const action = input.action;
  if (!messageId) {
    return Response.json({ error: "messageId is required." }, { status: 422 });
  }
  if (action !== "accept" && action !== "reject") {
    return Response.json(
      { error: 'action must be "accept" or "reject".' },
      { status: 422 },
    );
  }

  try {
    const result =
      action === "accept"
        ? await acceptReleaseProposal(db, authz.scope, id, messageId, {
            ...(typeof input.body === "string" ? { body: input.body } : {}),
          })
        : await rejectReleaseProposal(db, authz.scope, id, messageId);

    // The roadmap renders releases server-side, so an accepted set of notes has
    // to invalidate it or the flyout shows the new text over a page still
    // holding the old.
    if (action === "accept") revalidatePath("/", "layout");

    return Response.json(result);
  } catch (err) {
    if (err instanceof ProposalNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ProposalForbiddenError) {
      return Response.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ProposalSettledError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    // 409 as well, and for the same reason a git write conflict is one: the
    // request was valid and lost a race. The current body rides along so the
    // reviewer can see what they should have been reviewing against, rather
    // than being told no and left to go and find it.
    if (err instanceof ProposalStaleError) {
      return Response.json(
        { error: err.message, currentBody: err.currentBody },
        { status: 409 },
      );
    }
    if (err instanceof ProposalInvalidError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
