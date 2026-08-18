import { authorizeWrite } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  buildReleaseContext,
  ReleaseNotesForbiddenError,
  ReleaseNotesInputError,
  ReleaseNotFoundError,
  startReleaseNotesDraft,
  type DraftEvent,
} from "@/lib/release-notes-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ releaseId: string }> };

/**
 * Drafting a release's customer-facing notes.
 *
 * ── Why this lives under `/assistant` and not under `/releases` ─────────────
 * API key scopes are derived from the first path segment under `/api/v1`
 * (`lib/api-scopes.ts`). Nesting this under releases would mean any key granted
 * `releases:write` - "let this integration manage our versions" - could also
 * spend the customer's money at their model provider, without that ever having
 * been granted or even mentioned. Under `assistant` it needs `assistant:write`,
 * which is already exactly the grant that means "may spend inference budget",
 * so this adds a spend channel to a scope somebody opted into rather than
 * quietly adding one to a scope about dates and versions.
 *
 * Gated on write access rather than read: a draft is only useful to somebody who
 * can save it, and drafting costs money at the customer's provider. Offering it
 * to a viewer would be spending on a document with nowhere to go. That is a
 * different rule from the item assistant, where a reader may ask questions,
 * because asking a question is its own end and a draft is not.
 *
 * ── The protocol ────────────────────────────────────────────────────────────
 * The same NDJSON stream the assistant route uses, for the same reasons written
 * up there: `{"kind":"delta","text":"…"}` repeatedly, then exactly one `done` or
 * `error`. A model failure is a line in a 200 because by the time we know, the
 * status is long gone; our own refusals (unknown release, empty release, no
 * permission) are decided before streaming starts and stay ordinary JSON with a
 * status, which is why {@link startReleaseNotesDraft} does its checks eagerly.
 */

/** Needs a database + running server; unavailable in local file mode. */
const NO_DB = Response.json(
  {
    error:
      "Drafting release notes requires a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/** Map the service's eager refusals onto statuses. Shared by both methods. */
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
 * GET /api/v1/assistant/releases/:releaseId - what drafting would send.
 *
 * The disclosure, readable before anyone spends a token. It returns the same
 * `fields` the prompt is built from rather than a description of them, so the
 * two cannot drift apart.
 *
 * A GET that resolves through the write-gated service is deliberate: this
 * describes a spend that only an editor can trigger, so a viewer gets the same
 * 403 here as they would there rather than a preview of a button they will
 * never have.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { releaseId } = await params;
  try {
    const context = await buildReleaseContext(authz.scope, releaseId);
    return Response.json({
      fields: context.fields,
      itemsIncluded: context.itemsIncluded,
      itemsOmitted: context.itemsOmitted,
    });
  } catch (err) {
    const refused = refusal(err);
    if (refused) return refused;
    throw err;
  }
}

/**
 * POST /api/v1/assistant/releases/:releaseId - draft the notes.
 *
 * Takes no body. There is exactly one thing to ask for here, and an endpoint
 * that accepts free text would be the release assistant of the next feature
 * wearing this one's clothes: a thread, minus the history that makes a thread
 * worth having.
 *
 * Nothing is saved. The draft is streamed to the editor and the person saves it
 * through the ordinary release write path, or does not.
 *
 * ── Cancelling ──────────────────────────────────────────────────────────────
 * The browser aborts its fetch; `req.signal` fires; the abort reaches the
 * upstream request and closes the connection to the provider. The stream ends
 * with no terminal event, and whatever arrived is already in the editor.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { releaseId } = await params;

  let draft: AsyncGenerator<DraftEvent>;
  try {
    draft = await startReleaseNotesDraft(db, authz.scope, releaseId, {
      signal: req.signal,
    });
  } catch (err) {
    const refused = refusal(err);
    if (refused) return refused;
    throw err;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: DraftEvent) => {
        // Enqueueing to a stream whose consumer has gone throws. That is the
        // normal end of a cancelled draft, not a fault worth logging.
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The reader is gone; the loop below ends on the next abort check.
        }
      };
      try {
        for await (const event of draft) write(event);
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
                  : "The draft stopped unexpectedly.",
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
      // The reader went away (the sheet closed, the tab closed). Ending the
      // generator releases the upstream connection rather than leaving it
      // producing tokens nobody will read, which the customer still pays for.
      void draft.return(undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Tells an nginx-family proxy not to sit on the body until it is
      // complete, which would deliver the whole draft at once and make the
      // streaming pointless.
      "X-Accel-Buffering": "no",
    },
  });
}
