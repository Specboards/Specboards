import {
  affectedSpecs,
  parseIssuesEvent,
  parsePullRequestEvent,
  parsePushEvent,
  verifyWebhookSignature,
  type GithubEntityEvent,
} from "@specboard/git";
import { and, eq, featureGithubLinks, githubInstallations, type Database } from "@specboard/db";

import { getWorkerDb } from "@/lib/db";
import { getWebhookSecret } from "@/lib/github-app";
import { logSecurityEvent } from "@/lib/security-log";

/** GitHub webhook payloads are well under this; reject larger before reading. */
const MAX_WEBHOOK_BYTES = 5_000_000; // 5 MB
import { repoGlobs, resolveRepositories, syncRepository } from "@/lib/github-sync";

export const dynamic = "force-dynamic";

/**
 * Refresh the cached state/title of any links to the PR/issue this event
 * describes. Owner-side write (no RLS) keyed by repo + kind + number. No-op
 * when the repo isn't connected or nothing links to the entity.
 */
async function updateLinksFromEntityEvent(
  db: Database,
  evt: GithubEntityEvent,
): Promise<number> {
  // Update every workspace that connected this repo, not just one.
  const repos = await resolveRepositories(db, evt.owner, evt.name);
  let total = 0;
  for (const repo of repos) {
    const updated = await db
      .update(featureGithubLinks)
      .set({ state: evt.state, title: evt.title })
      .where(
        and(
          eq(featureGithubLinks.repoId, repo.id),
          eq(featureGithubLinks.kind, evt.kind),
          eq(featureGithubLinks.number, evt.number),
        ),
      )
      .returning({ id: featureGithubLinks.id });
    total += updated.length;
  }
  return total;
}

/**
 * GitHub App webhook sink. Verifies the HMAC signature against
 * `GITHUB_WEBHOOK_SECRET`, then on a push to a connected repo's default branch
 * reconciles its specs into `features` + `spec_index`.
 *
 * Writes go through the dedicated worker connection (`getWorkerDb()`), the
 * narrow non-owner `specboard_worker` role: this is cross-workspace ingestion
 * with no per-user scope, but it no longer needs the broad owner connection.
 * Non-actionable deliveries (ping, other branches, no matching spec changes)
 * return 2xx so GitHub marks them handled.
 */
export async function POST(req: Request) {
  const db = getWorkerDb();
  const secret = db ? await getWebhookSecret(db) : null;
  if (!secret || !db) {
    return Response.json(
      { error: "GitHub sync is not configured on this deployment." },
      { status: 501 },
    );
  }

  // Bound the body before reading it in (defends against a memory-exhaustion
  // delivery ahead of the HMAC check).
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    logSecurityEvent("request-oversized", { endpoint: "github-webhook", bytes: declared });
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }

  // Raw body is required: re-serializing parsed JSON would change the bytes the
  // HMAC was computed over.
  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) {
    logSecurityEvent("request-oversized", { endpoint: "github-webhook", bytes: raw.length });
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  if (!verifyWebhookSignature(raw, signature, secret)) {
    // Repeated failures here mean either a secret mismatch or someone probing
    // the endpoint; make it greppable rather than a silent 401.
    logSecurityEvent("webhook-signature-invalid", {
      endpoint: "github-webhook",
      event: req.headers.get("x-github-event") ?? "unknown",
      delivery: req.headers.get("x-github-delivery") ?? "none",
    });
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  if (event === "ping") return Response.json({ ok: true });
  if (
    event !== "push" &&
    event !== "pull_request" &&
    event !== "issues" &&
    event !== "installation"
  ) {
    return Response.json({ ignored: event ?? "unknown" }, { status: 202 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  // installation: drop workspace bindings when the App is uninstalled, so the
  // connect picker stops offering an installation that can no longer mint
  // tokens. (GitHub always delivers installation events to Apps, independent
  // of the subscribed events.)
  if (event === "installation") {
    const evt = payload as { action?: string; installation?: { id?: number } } | null;
    const installationId = evt?.installation?.id;
    if (evt?.action === "deleted" && typeof installationId === "number") {
      const removed = await db
        .delete(githubInstallations)
        .where(eq(githubInstallations.installationId, String(installationId)))
        .returning({ id: githubInstallations.id });
      return Response.json({ ok: true, removed: removed.length });
    }
    return Response.json({ ignored: `installation ${evt?.action ?? "unknown"}` }, { status: 202 });
  }

  // pull_request / issues: refresh cached link state (open → merged/closed).
  if (event === "pull_request" || event === "issues") {
    const entity =
      event === "pull_request"
        ? parsePullRequestEvent(payload)
        : parseIssuesEvent(payload);
    if (!entity) return Response.json({ ignored: `malformed ${event}` }, { status: 202 });
    try {
      const updated = await updateLinksFromEntityEvent(db, entity);
      return Response.json({ ok: true, updated });
    } catch (err) {
      console.error(`[webhooks/github] ${event} update failed:`, err);
      return Response.json({ error: "Link update failed." }, { status: 500 });
    }
  }

  const push = parsePushEvent(payload);
  if (!push) return Response.json({ ignored: "non-branch or malformed push" }, { status: 202 });

  // Reconcile every workspace that connected this repo (the same repo can be
  // connected by more than one tenant), each against its own default branch and
  // spec globs, rather than picking one connection nondeterministically.
  const repos = await resolveRepositories(db, push.owner, push.name);
  if (repos.length === 0) {
    return Response.json(
      { error: `Repository ${push.owner}/${push.name} is not connected.` },
      { status: 404 },
    );
  }

  let synced = 0;
  let failed = 0;
  for (const repo of repos) {
    if (push.ref !== repo.defaultBranch) continue;
    // Skip the full reconcile when nothing under this repo's globs changed.
    if (affectedSpecs(push, repoGlobs(repo)).length === 0) continue;
    try {
      await syncRepository(db, repo);
      synced += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[webhooks/github] sync failed for ${push.owner}/${push.name} (workspace ${repo.workspaceId}):`,
        err,
      );
    }
  }

  // 500 (so GitHub retries) only if a connection actually failed to sync.
  if (failed > 0) return Response.json({ error: "Sync failed." }, { status: 500 });
  return Response.json({ ok: true, synced });
}
