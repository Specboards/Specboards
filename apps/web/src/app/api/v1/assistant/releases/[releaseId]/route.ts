import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  getReleaseAssistantPanelData,
  ReleaseNotesForbiddenError,
  ReleaseNotesInputError,
  ReleaseNotFoundError,
  startReleaseTurn,
  type ReleaseAssistantEvent,
} from "@/lib/release-notes-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ releaseId: string }> };

/**
 * The assistant conversation about a release.
 *
 * ── Why this lives under `/assistant` and not under `/releases` ─────────────
 * API key scopes are derived from the first path segment under `/api/v1`
 * (`lib/api-scopes.ts`). Nesting this under releases would mean any key granted
 * `releases:write` - "let this integration manage our versions" - could also
 * spend the customer's money at their model provider, without that ever having
 * been granted or even mentioned. Under `assistant` it needs `assistant:write`,
 * which is already exactly the grant that means "may spend inference budget".
 *
 * Accepting a proposal is the mirror image and lives under
 * `/api/v1/releases/:id/proposals` for the mirror reason: accepting is a change
 * to the release, so it needs the grant that lets a caller edit the release by
 * hand. Drafting and approving stay two separate decisions.
 *
 * ── Why both verbs need write access ────────────────────────────────────────
 * Unlike the item assistant, where any reader may ask a question, this one is
 * gated on being able to change the release. A release assistant exists to
 * produce one document, and somebody who cannot save that document would be
 * spending the workspace's money on something with nowhere to go.
 *
 * ── The protocol ────────────────────────────────────────────────────────────
 * The same NDJSON stream the item assistant uses, for the reasons written up on
 * that route: `{"kind":"delta","text":"…"}` repeatedly, then exactly one `done`
 * or `error`. A model failure is a line in a 200, because by the time we know,
 * the status is long gone. Our own refusals are decided before streaming starts
 * and stay ordinary JSON with a status, which is why {@link startReleaseTurn}
 * does its checks eagerly.
 */

/** Needs a database + running server; unavailable in local file mode. */
const NO_DB = Response.json(
  {
    error: "The assistant requires a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/** Map the service's eager refusals onto statuses. Shared by both verbs. */
function refusal(err: unknown): Response | null {
  if (err instanceof ReleaseNotFoundError) {
    return Response.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof ReleaseNotesForbiddenError) {
    return Response.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof ReleaseNotesInputError) {
    return Response.json({ error: err.message }, { status: 422 });
  }
  return null;
}

/**
 * GET /api/v1/assistant/releases/:releaseId - the thread, oldest first, plus
 * what would be sent about this release.
 *
 * `context` is returned alongside so the panel can disclose it before anyone
 * spends a token, rather than describing it from a second source that can fall
 * out of step with the request.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { releaseId } = await params;
  try {
    return Response.json(
      await getReleaseAssistantPanelData(db, authz.scope, releaseId),
    );
  } catch (err) {
    const refused = refusal(err);
    if (refused) return refused;
    throw err;
  }
}

/**
 * POST /api/v1/assistant/releases/:releaseId - ask. Body: `{ message, skillKey? }`.
 *
 * With a `skillKey` and an empty `message`, the skill's own name becomes the
 * question, which is what pressing "Draft the notes" is. Only release skills are
 * accepted: an item skill pointed at a release produces a confident answer about
 * something that is not on the screen.
 *
 * Nothing is saved to the release. An answer may carry a proposal, which is
 * inert text until somebody accepts it through the proposals route.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { releaseId } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  let turn: AsyncGenerator<ReleaseAssistantEvent>;
  try {
    turn = await startReleaseTurn(
      db,
      authz.scope,
      releaseId,
      typeof body.message === "string" ? body.message : "",
      {
        signal: req.signal,
        // Sent on every turn, not just the one that launched it: the client
        // owns what is in force, and a drafting session has to survive the
        // person answering a question about it.
        ...(typeof body.skillKey === "string" ? { skillKey: body.skillKey } : {}),
      },
    );
  } catch (err) {
    const refused = refusal(err);
    if (refused) return refused;
    throw err;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: ReleaseAssistantEvent) => {
        // Enqueueing to a stream whose consumer has gone throws. That is the
        // normal end of a cancelled turn, not a fault worth logging.
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The reader is gone; the loop below ends on the next abort check.
        }
      };
      try {
        for await (const event of turn) write(event);
      } catch (err) {
        // An unexpected throw mid-stream: the status is already sent, so the
        // only way left to say anything is another event.
        if (!req.signal.aborted) {
          write({
            kind: "error",
            error: {
              kind: "unknown",
              message:
                err instanceof Error
                  ? err.message
                  : "The assistant stopped unexpectedly.",
            },
          });
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the disconnect.
        }
      }
    },
    cancel() {
      // The reader went away (the flyout closed, the tab closed). Ending the
      // generator releases the upstream connection rather than leaving it
      // producing tokens nobody will read, which the customer still pays for.
      void turn.return(undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Tells an nginx-family proxy not to sit on the body until it is
      // complete, which would deliver the whole answer at once.
      "X-Accel-Buffering": "no",
    },
  });
}
