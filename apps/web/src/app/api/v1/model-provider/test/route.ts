import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { completeWithWorkspaceModel } from "@/lib/model-provider-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/model-provider/test - send one real completion to the configured
 * endpoint and report what came back. Admin-only.
 *
 * This is the tracer bullet for the epic. Its value is not the feature (asking
 * a model to say "ready" is worth nothing on its own) but the proof that the
 * whole path connects: the settings row, credential decryption, the egress
 * policy, the adapter, and the error vocabulary that the assistant will branch
 * on. Everything downstream is about to assume all five work.
 *
 * Deliberately narrow. Listing available models, picking one, and workspace
 * defaults are their own feature in this epic; this asks the one configured
 * model one fixed question and reports the answer verbatim.
 */

const NO_DB = Response.json(
  {
    error:
      "A model connection requires a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/** Short, cheap, and answerable by any instruction-following model. */
const PROMPT = "Reply with the single word: ready";

export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const started = Date.now();
  const outcome = await completeWithWorkspaceModel(db, authz.scope.workspaceId, {
    messages: [{ role: "user", content: PROMPT }],
    maxTokens: 16,
    // Tighter than the adapter default: someone is watching this run, and a
    // 30s hang on a wrong URL reads as the app being broken.
    timeoutMs: 15_000,
  });
  const elapsedMs = Date.now() - started;

  if (outcome.ok) {
    return Response.json({
      ok: true,
      // Trimmed and capped: this is echoed into the settings page, and a model
      // that ignores the instruction can be verbose.
      reply: outcome.text.trim().slice(0, 200),
      model: outcome.model,
      usage: outcome.usage,
      elapsedMs,
    });
  }

  if (outcome.error.kind === "not_configured") {
    return Response.json(
      {
        ok: false,
        kind: "not_configured",
        error: "No model is connected for this workspace yet.",
      },
      { status: 409 },
    );
  }

  // 200 with ok:false, not an HTTP error status. The request to *us* succeeded;
  // it is the call to the customer's endpoint that failed, and the UI needs the
  // kind and message to say which. A 502 here would make a wrong API key look
  // like a Specboards outage in every log and uptime check we have.
  return Response.json({
    ok: false,
    kind: outcome.error.kind,
    error: outcome.error.message,
    status: outcome.error.status,
    elapsedMs,
  });
}
