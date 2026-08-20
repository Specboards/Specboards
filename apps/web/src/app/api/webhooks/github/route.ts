import {
  affectedSpecs,
  parseIssuesEvent,
  parsePullRequestEvent,
  parsePushEvent,
  verifyWebhookSignature,
  type GithubEntityEvent,
} from "@specboards/git";
import { and, eq, featureGithubLinks, githubInstallations, type Database } from "@specboards/db";

import { readTextBodyWithin } from "@/lib/api/body";
import { getWorkerDb } from "@/lib/db";
import { claimDelivery, pruneDeliveries } from "@/lib/github-delivery-dedup";
import { getWebhookSecret } from "@/lib/github-app";
import { checkQuota, QUOTAS } from "@/lib/rate-limit";
import { notifyReviewOutcome } from "@/lib/review-outcome-notify";
import { logSecurityEvent } from "@/lib/security-log";

/** GitHub webhook payloads are well under this; reject larger before reading. */
const MAX_WEBHOOK_BYTES = 5_000_000; // 5 MB
import { repoGlobs, resolveRepositories, syncRepository } from "@/lib/github-sync";

export const dynamic = "force-dynamic";

/**
 * Refresh the cached state/title of any links to the PR/issue this event
 * describes. Owner-side write (no RLS) keyed by repo + kind + number. No-op
 * when the repo isn't connected or nothing links to the entity.
 *
 * Takes the connected repositories rather than resolving them, so this and the
 * notification that follows are scoped by one resolution and cannot disagree
 * about which repos the event touched.
 */
async function updateLinksFromEntityEvent(
  db: Database,
  evt: GithubEntityEvent,
  repos: { id: string }[],
): Promise<number> {
  let total = 0;
  for (const repo of repos) {
    const updated = await db
      .update(featureGithubLinks)
      // Stamping the check time here is what keeps the view-path reconcile
      // idle: a working webhook confirms the state continuously, so nothing
      // ever looks stale enough to be worth an API call.
      .set({ state: evt.state, title: evt.title, stateCheckedAt: new Date() })
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
 * narrow non-owner `specboards_worker` role: this is cross-workspace ingestion
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

  // Bound the body as it arrives, in bytes. This check sits ahead of the HMAC
  // (it has to: the signature is computed over the body we have not read yet),
  // so it is reachable by anyone who can reach the endpoint. It used to buffer
  // the whole delivery with `req.text()` before deciding, which made the cap
  // bound the response rather than the allocation.
  //
  // Raw text, not parsed JSON: re-serializing would change the bytes the HMAC
  // was computed over.
  const raw = await readTextBodyWithin(req, MAX_WEBHOOK_BYTES, "github-webhook");
  if (raw === null) {
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
  // Ping carries no state to duplicate, and GitHub sends it on setup before
  // anything is configured; let it through without consuming a delivery id.
  if (event === "ping") return Response.json({ ok: true });

  // Claim the delivery before acting on it. A valid signature says GitHub sent
  // this, not that GitHub sent it for the first time: without this, a captured
  // delivery (or a click in GitHub's redelivery UI) re-runs the sync path, and
  // for pull_request events re-notifies the author of a merge they were already
  // told about. 2xx on a duplicate so GitHub marks it handled rather than
  // retrying into the same wall.
  const claim = await claimDelivery(db, req.headers.get("x-github-delivery"));
  if (!claim.ok) {
    return Response.json(
      claim.reason === "duplicate"
        ? { ok: true, duplicate: true }
        : { error: "Missing x-github-delivery header." },
      { status: claim.reason === "duplicate" ? 200 : 400 },
    );
  }
  void pruneDeliveries(db);
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
      // Resolved once and handed to both: every workspace that connected this
      // repo, and nothing else. A pull request number is unique only within a
      // repository, so this set is what stops an event from a repo an attacker
      // owns reaching link rows that merely share its number. The returned
      // counts are scoped by the same set, which matters because GitHub shows
      // this response in the sender's delivery log.
      const repos = await resolveRepositories(db, entity.owner, entity.name);
      const updated = await updateLinksFromEntityEvent(db, entity, repos);
      // After the state lands, tell whoever proposed the change what happened
      // to it. Ordered this way on purpose: the notification reads the stored
      // state back, and it must never be the reason the state update is lost.
      const notified = await notifyReviewOutcome(
        db,
        entity,
        repos.map((r) => r.id),
      );
      return Response.json({ ok: true, updated, notified });
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
  let throttled = 0;
  for (const repo of repos) {
    if (push.ref !== repo.defaultBranch) continue;
    // Skip the full reconcile when nothing under this repo's globs changed.
    if (affectedSpecs(push, repoGlobs(repo)).length === 0) continue;
    // Counted per connected repository, and only once the work is known to be
    // needed, so a quiet repo's quota is never spent by pushes that touch no
    // specs. Keyed on the connection rather than the caller because the caller
    // is always GitHub.
    const quota = await checkQuota(db, QUOTAS.githubPushSync, repo.id);
    if (!quota.ok) {
      throttled += 1;
      continue;
    }
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
  // 429 rather than 200 when work was skipped for quota, so GitHub retries with
  // backoff and the sync lands late instead of being silently dropped. Only
  // when nothing else succeeded: a delivery that synced one connection and
  // throttled another has already done real work, and a retry would repeat it.
  if (throttled > 0 && synced === 0) {
    return Response.json(
      { error: "This repository is syncing too frequently; retry shortly." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  return Response.json({ ok: true, synced, ...(throttled ? { throttled } : {}) });
}
