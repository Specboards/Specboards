import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import {
  acceptProposal,
  rejectProposal,
  ProposalForbiddenError,
  ProposalInvalidError,
  ProposalNotFoundError,
  ProposalSettledError,
  ProposalStaleError,
  ProposalTooLongError,
} from "@/lib/assistant-proposals";
import { AssistantItemError } from "@/lib/assistant-service";
import { getAppDb } from "@/lib/db";
import { SpecConflictError, SpecContentError } from "@/lib/spec-content";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/**
 * Deciding about an edit the assistant proposed.
 *
 * ── Why this lives under `features` and not under `assistant` ───────────────
 * Scopes are derived from the first path segment (`lib/api-scopes.ts`), and the
 * whole point of this endpoint is that accepting is a *change to the item*, not
 * a use of the assistant. Under `/assistant` a key granted `assistant:write`
 * could both draft a proposal and approve it, which is the exact failure the
 * feature exists to prevent, arriving as a side effect of turning the assistant
 * on. Here it needs `features:write`: the same grant that lets a caller edit the
 * item by hand, which is what accepting is.
 *
 * A caller holding both grants can still self-approve. That is a customer
 * deciding to let an agent write their specs, which is a legitimate thing to
 * decide and a deliberate one to configure. What must not happen is it being
 * decided for them.
 */
const NO_DB = Response.json(
  {
    error: "Proposals require a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/**
 * POST /api/v1/features/:specId/proposals
 * Body: `{ messageId, action: "accept" | "reject", body? }`.
 *
 * `body` replaces what the assistant drafted, which is "edit before accepting":
 * the reviewer changed a line before saying yes, and what lands is their text.
 *
 * A 409 carries the conflict from the underlying write when the spec moved in a
 * way that could not be merged, in the same shape the editor's own save returns,
 * so the caller has the version that won rather than only the news that it did.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getAppDb();
  if (!db || !authz.scope) return NO_DB;

  const { specId } = await params;
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
        ? await acceptProposal(db, authz.scope, specId, messageId, {
            ...(typeof input.body === "string" ? { body: input.body } : {}),
          })
        : await rejectProposal(db, authz.scope, specId, messageId);
    // An accepted edit that landed changes what every view of this item renders.
    // Same rule as the editor's own save: a change proposed to git as a pull
    // request has not touched the default branch, so there is nothing new to
    // re-read and dropping the cache would only make readers refetch what they
    // already have.
    if (action === "accept" && !result.pullRequest) {
      revalidatePath("/[org]/[product]/backlog/[...slug]", "page");
      for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"])
        revalidatePath(path, "page");
    }
    return Response.json(result);
  } catch (err) {
    // Unknown item and unknown message are both 404 and deliberately read the
    // same from outside: telling them apart would let a caller probe for items
    // in products they cannot see.
    if (err instanceof AssistantItemError || err instanceof ProposalNotFoundError) {
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
    // 422 rather than 409: nothing raced, the document is simply too long for a
    // whole-document rewrite to be safe, and retrying changes nothing until it
    // is shortened. The message says that.
    if (err instanceof ProposalTooLongError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
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
    if (err instanceof SpecContentError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
