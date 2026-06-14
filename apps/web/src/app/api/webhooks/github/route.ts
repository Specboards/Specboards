import { affectedSpecs, parsePushEvent, verifyWebhookSignature } from "@specboard/git";

import { getDb } from "@/lib/db";
import { getWebhookSecret } from "@/lib/github-app";
import { repoGlobs, resolveRepository, syncRepository } from "@/lib/github-sync";

export const dynamic = "force-dynamic";

/**
 * GitHub App webhook sink. Verifies the HMAC signature against
 * `GITHUB_WEBHOOK_SECRET`, then on a push to a connected repo's default branch
 * reconciles its specs into `features` + `spec_index`.
 *
 * Writes go through the owner connection (`getDb()`) — this is owner-side
 * ingestion, not a tenant request. Non-actionable deliveries (ping, other
 * branches, no matching spec changes) return 2xx so GitHub marks them handled.
 */
export async function POST(req: Request) {
  const db = getDb();
  const secret = db ? await getWebhookSecret(db) : null;
  if (!secret || !db) {
    return Response.json(
      { error: "GitHub sync is not configured on this deployment." },
      { status: 501 },
    );
  }

  // Raw body is required: re-serializing parsed JSON would change the bytes the
  // HMAC was computed over.
  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  if (!verifyWebhookSignature(raw, signature, secret)) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  if (event === "ping") return Response.json({ ok: true });
  if (event !== "push") return Response.json({ ignored: event ?? "unknown" }, { status: 202 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const push = parsePushEvent(payload);
  if (!push) return Response.json({ ignored: "non-branch or malformed push" }, { status: 202 });

  const repo = await resolveRepository(db, push.owner, push.name);
  if (!repo) {
    return Response.json(
      { error: `Repository ${push.owner}/${push.name} is not connected.` },
      { status: 404 },
    );
  }

  if (push.ref !== repo.defaultBranch) {
    return Response.json({ ignored: `push to ${push.ref}` }, { status: 202 });
  }

  // Skip the full reconcile when nothing under the spec globs changed.
  if (affectedSpecs(push, repoGlobs(repo)).length === 0) {
    return Response.json({ ok: true, changed: 0 });
  }

  try {
    const summary = await syncRepository(db, repo);
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    // 500 so GitHub retries the delivery; the cause is logged for ops.
    console.error(`[webhooks/github] sync failed for ${push.owner}/${push.name}:`, err);
    return Response.json({ error: "Sync failed." }, { status: 500 });
  }
}
