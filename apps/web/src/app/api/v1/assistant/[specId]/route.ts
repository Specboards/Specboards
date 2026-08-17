import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  AssistantInputError,
  AssistantItemError,
  getAssistantPanelData,
  startAssistantTurn,
  type AssistantEvent,
} from "@/lib/assistant-service";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/**
 * The assistant conversation about an item.
 *
 * ── Why this is `/assistant/{specId}` and not `/features/{specId}/assistant` ─
 * The nested URL is the tidier REST shape and it is the wrong one here. API key
 * scopes are derived from the first path segment under `/api/v1`
 * (`lib/api-scopes.ts`), so nesting this under features would mean any key
 * granted `features:write` - "let this integration edit our items" - could also
 * spend the customer's money at their model provider, without that ever having
 * been granted or even mentioned. As its own resource it needs an explicit
 * `assistant:write`, so the spend channel is something a person opted into.
 *
 * Gated at member level, not admin: configuring the connection is owner-only
 * because it picks the endpoint and holds the key, but *using* it is ordinary
 * product work. The rule is the same as commenting - anyone who can read the
 * item can ask about it - and the per-product visibility check that enforces
 * it lives in the service, which resolves the item before doing anything else.
 *
 * A completion is a write in every sense that matters here (it costs money at
 * the customer's provider and it appends to a persisted thread), so POST takes
 * the write path rather than the read one.
 */

/** Needs a database + running server; unavailable in local file mode. */
const NO_DB = Response.json(
  {
    error: "The assistant requires a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/**
 * GET /api/v1/assistant/:specId - the thread, oldest first, plus what would be
 * sent about this item. `context` is returned alongside so the panel
 * can disclose it before anyone spends a token, rather than describing it from
 * a second source that can fall out of step.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { specId } = await params;
  try {
    return Response.json(await getAssistantPanelData(db, authz.scope, specId));
  } catch (err) {
    if (err instanceof AssistantItemError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

/**
 * POST /api/v1/assistant/:specId - ask a question. Body: { message, skillKey? }.
 *
 * `skillKey` names the skill in force (see `lib/ai/skills.ts`); with it and an
 * empty `message`, the skill's own name becomes the question. Editing skills is
 * a different resource with a different scope, deliberately: see
 * `/api/v1/assistant-skills`.
 *
 * Answers with a stream of newline-delimited JSON events, one per line:
 * `{"kind":"delta","text":"…"}` repeatedly, then exactly one
 * `{"kind":"done","turns":[…]}` or `{"kind":"error","error":{kind,message}}`.
 *
 * ── Why NDJSON and not server-sent events ───────────────────────────────────
 * SSE is the convention and its one real advantage, `EventSource`, is
 * unavailable to us: `EventSource` cannot issue a POST, and the question does
 * not belong in a URL. That leaves reading the body off `fetch` either way, and
 * once you are doing that, "split on newline, parse each line" is the whole
 * protocol, with no framing rules to get subtly wrong.
 *
 * ── Why a model failure is a line in a 200 ──────────────────────────────────
 * By the time the endpoint refuses we may already have sent text, and the
 * status line is long gone. Rather than have failures arrive one way before the
 * first token and another way after, they are always an event. The request to
 * Specboards genuinely did succeed; what failed is a call to a third party the
 * customer configured, and `kind` is what lets the panel tell "connect a model
 * first" from "your key is wrong" from "that endpoint is unreachable".
 *
 * Refusals that are *ours* - unknown item, unusable message - still come back
 * as ordinary 404/422 JSON, because they are decided before any streaming
 * starts. That is why {@link startAssistantTurn} does its checks eagerly.
 *
 * ── Cancelling ──────────────────────────────────────────────────────────────
 * The browser aborts its fetch; `req.signal` fires; the abort is passed down to
 * the upstream request, which closes the connection to the provider. There is
 * no cancel call in the protocol, so closing the connection is the mechanism.
 * The stream ends with no terminal event and nothing is written.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { specId } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  let turn: AsyncGenerator<AssistantEvent>;
  try {
    turn = await startAssistantTurn(
      db,
      authz.scope,
      specId,
      typeof body.message === "string" ? body.message : "",
      {
        signal: req.signal,
        // A skill is a saved way of asking, so it rides on the ordinary turn
        // rather than getting an endpoint of its own. Sent on every turn, not
        // just the one that launched it: the client owns what is in force, and
        // an interrogation has to survive the person answering a question.
        ...(typeof body.skillKey === "string" ? { skillKey: body.skillKey } : {}),
      },
    );
  } catch (err) {
    if (err instanceof AssistantItemError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof AssistantInputError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: AssistantEvent) => {
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
        // only way to say anything is another event.
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
      // The reader went away (navigation, tab close). Ending the generator
      // releases the upstream connection rather than leaving it producing
      // tokens nobody will ever read, which the customer is still paying for.
      void turn.return(undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Tells an nginx-family proxy not to sit on the body until it is
      // complete, which would deliver the whole answer at once and make all
      // of this pointless.
      "X-Accel-Buffering": "no",
    },
  });
}
