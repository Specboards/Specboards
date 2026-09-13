import { eq, ideaStatuses, ideas } from "@specboards/db";
import { resolveIdeaStages } from "@specboards/core";

import { readJsonBody } from "@/lib/api/body";
import { rateLimitKey } from "@/lib/client-ip";
import { getDb } from "@/lib/db";
import { renderInfoEmail, sendEmail } from "@/lib/email";
import { isLocalFileMode } from "@/lib/local-mode";
import { portalShowsIdeas, resolvePortal } from "@/lib/portal/resolve";
import { QUOTAS, enforceQuota } from "@/lib/rate-limit";
import { revalidateIdeaPages } from "@/lib/revalidate-cards";
import { getStore } from "@/lib/store";
import type { PortalVisibility } from "@/lib/store/types";

/**
 * Public idea intake: `POST /api/portal/{org}/ideas`.
 *
 * The first endpoint in the product that lets somebody with no account WRITE,
 * and the first thing ever to put a value in `ideas.submitter_name` /
 * `submitter_email`, which have existed unused since v0.8.0.
 *
 * `app/api/access-request/route.ts` is the working template for this shape and
 * most of the structure is borrowed from it: read the body through the size
 * guard, honeypot, validate, spend quota only after validating, then persist
 * and mail. Three things differ, each for a reason.
 *
 * ── 1. No CORS, and deliberately no CSRF exemption ─────────────────────────
 * The access-request endpoint is posted to cross-origin by the marketing site,
 * so it carries an allow-list and echoes `Access-Control-Allow-Origin`. This
 * one is posted to only by `/{org}/ideas`, served from the app's own origin, so
 * the request is same-origin and `originAllowed` already accepts it.
 *
 * There is no `EXEMPT_PREFIXES` entry here and there must not be one. This
 * endpoint reads no session, so the origin check costs it nothing and is one
 * more thing keeping a cross-site POST off it; an exemption that buys nothing
 * is surface area. The reason this is asserted rather than assumed is #460,
 * where the same origin rule silently closed the request-access funnel while
 * `csrf-origin.test.ts` passed throughout, because it tested the predicate and
 * the failure lived in the composition. So both directions are covered by
 * cases: a same-origin POST is accepted, a foreign-origin POST is refused.
 *
 * ── 2. It writes tenant data, on the owner connection ──────────────────────
 * `getPortalDb()` is SELECT-only by design, and that is load-bearing rather
 * than incidental: `infra/portal-role.sql` says in as many words that "a public
 * submission and a public vote are writes, and they go through their own intake
 * path with their own quotas and validation, on a different connection". This
 * is that path and that connection.
 *
 * The cost is that the owner connection bypasses RLS, so the `workspaceId` on
 * the insert IS the tenant enforcement rather than a belt beside braces. That
 * is why the workspace is never taken from the request body: it is resolved
 * from the URL by `resolvePortal`, which reads on the PORTAL connection, where
 * RLS admits only a workspace whose portal is actually published. The write is
 * bounded by a read the database policed.
 *
 * ── 3. The moderation mode decides whether anyone sees it ──────────────────
 * `review_first` (the default) lands the row `pending`; `immediate` lands it
 * `published`. Both are still subject to the visibility model on top, which is
 * the point of keeping the two orthogonal (0012).
 */

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim to a max length; guards the stored row and the email body. */
function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Both quotas, cheaper one first. See `QUOTAS.portalIdea` for why there are two.
 *
 * `enforceQuota` no-ops without a database, which in practice means local file
 * mode: single tenant, bound to loopback, no portal reachable from anywhere
 * else, so there is nothing to throttle and nobody to throttle it from.
 */
async function overQuota(req: Request, email: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const perClient = await enforceQuota(
    db,
    QUOTAS.portalIdea,
    rateLimitKey(req, "portal-idea"),
  );
  if (perClient) return true;
  return (await enforceQuota(db, QUOTAS.portalIdeaEmail, email)) !== null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ org: string }> },
) {
  const { org } = await params;

  // The same resolution the public pages use, so this endpoint exists exactly
  // when the portal does. An unpublished or unknown org is one 404 with no way
  // to tell which apart, because a POST that answered differently would be a
  // cheaper oracle than the pages that already refuse to be one.
  const portal = await resolvePortal(org);
  if (!portal || !portalShowsIdeas(portal.settings)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return Response.json(
      {
        error:
          parsed.response.status === 413
            ? "That is too long. Please shorten it and try again."
            : "Request body must be JSON.",
      },
      { status: parsed.response.status },
    );
  }
  const body = parsed.body as Record<string, unknown>;

  // Honeypot, as on the access-request form: fields hidden from humans that
  // bots fill in anyway. Answer 200 so the bot learns nothing from the
  // difference, and write nothing.
  if (clip(body.website, 200) || clip(body.url, 200)) {
    return Response.json({ ok: true, moderated: true }, { status: 200 });
  }

  const title = clip(body.title, 200);
  const description = clip(body.description, 4000);
  const name = clip(body.name, 200);
  const email = clip(body.email, 320).toLowerCase();

  if (!title) {
    return Response.json(
      { error: "Please give your idea a title." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email)) {
    // Required, and not only so the confirmation has somewhere to go.
    // `isExternalSubmission` is derived from this column, so a submission
    // without one would be indistinguishable from an internal capture on the
    // moderation queue, which is the distinction that queue exists to make.
    return Response.json(
      { error: "A valid email address is required." },
      { status: 400 },
    );
  }

  // Which backlog to file against. A portal can publish several products, and
  // choosing for the submitter would file their idea against one they never
  // picked, so the form asks whenever there is a choice. A product this portal
  // does not publish is refused rather than quietly redirected: accepting it
  // would let an outsider file into an unpublished backlog.
  const requested = clip(body.productId, 64);
  const published = portal.settings.portalProductIds;
  const productId = requested || published[0];
  if (!productId || !published.includes(productId)) {
    return Response.json({ error: "Unknown product." }, { status: 400 });
  }

  // After validation, so a malformed submission does not spend somebody's
  // quota, and before any write or send, so the quota is what bounds both.
  if (await overQuota(req, email)) {
    return Response.json(
      { error: "Too many submissions. Please try again later." },
      { status: 429 },
    );
  }

  const visibility: PortalVisibility =
    portal.settings.portalModeration === "immediate" ? "published" : "pending";

  try {
    await persist({
      workspaceId: portal.workspaceId,
      productId,
      title,
      description,
      name,
      email,
      visibility,
    });
  } catch (err) {
    // Unlike the access request there is no email fallback that still reaches a
    // human usefully: the row IS the deliverable, and confirming an idea nobody
    // recorded is worse than an honest failure.
    console.error("[portal-idea] persist failed", err);
    return Response.json(
      { error: "We could not save your idea. Please try again." },
      { status: 500 },
    );
  }

  // A published submission is on the internal board immediately, so refresh it.
  // The public pages are rendered per request and hold no cache entry (see
  // `revalidate-cards.ts`), so there is nothing to invalidate there.
  revalidateIdeaPages();

  // Sent after the row is safely written, and a failure here does NOT fail the
  // request: the idea is recorded, and telling the submitter otherwise invites
  // a duplicate. Logged, so a broken mail path is still visible.
  try {
    const confirm = renderInfoEmail({
      name: name || undefined,
      intro: [
        `Thanks for suggesting "${title}" to ${portal.title}.`,
        visibility === "published"
          ? "It is now on the public ideas page, where others can see it and vote for it."
          : "The team will review it shortly. It will appear on the public ideas page once they publish it.",
      ],
      footer: `You are receiving this because you submitted an idea at ${portal.title}.`,
    });
    await sendEmail({
      to: email,
      subject: `We received your idea for ${portal.title}`,
      textBody: confirm.textBody,
      htmlBody: confirm.htmlBody,
    });
  } catch (err) {
    console.error("[portal-idea] confirmation send failed", err);
  }

  return Response.json({ ok: true, moderated: visibility === "pending" });
}

/** Write the submission, in whichever mode this deployment runs. */
async function persist(input: {
  workspaceId: string;
  productId: string;
  title: string;
  description: string;
  name: string;
  email: string;
  visibility: PortalVisibility;
}): Promise<void> {
  const status = await firstIdeaStage(input.workspaceId);

  if (isLocalFileMode()) {
    // No Postgres, one workspace, loopback only. The local store's `createIdea`
    // now carries the submitter fields, so this is one call and not a
    // create-then-patch that could leave a half-written row.
    const store = await getStore();
    const created = await store.createIdea({
      title: input.title,
      description: input.description || null,
      productId: input.productId,
      submitterName: input.name || null,
      submitterEmail: input.email,
      portalVisibility: input.visibility,
    });
    // `createIdea` hard-codes the first built-in stage; a workspace with a
    // custom workflow needs its own first stage instead.
    if (created.status !== status) {
      await store.updateIdea(created.id, { status });
    }
    return;
  }

  const db = getDb();
  if (!db) throw new Error("No database configured for portal intake.");

  await db.insert(ideas).values({
    workspaceId: input.workspaceId,
    productId: input.productId,
    title: input.title,
    description: input.description || null,
    status,
    // Null, and not the submitter. `author_id` means an internal member, and
    // putting a stranger's identity there would make an external submission
    // indistinguishable from a colleague's capture.
    authorId: null,
    submitterName: input.name || null,
    submitterEmail: input.email,
    portalVisibility: input.visibility,
  });
}

/**
 * The stage a new submission lands at: the first in the workspace's workflow.
 *
 * Untriaged is the honest answer for something nobody has looked at, and it is
 * what an internally captured idea gets too (`createIdea` uses `new`).
 *
 * The interaction with `immediate` moderation is real and is not papered over
 * here. Landing at the first stage means the idea is visible only if the
 * workspace also publishes that stage, and most publish `planned` and `shipped`
 * rather than `new`, so "publish immediately" grants permission without
 * necessarily granting visibility. Landing submissions at the first PUBLISHED
 * stage instead would be worse: an untriaged suggestion would arrive already
 * labelled "Planned" to every reader. The settings screen warns about the
 * combination rather than the intake guessing around it.
 */
async function firstIdeaStage(workspaceId: string): Promise<string> {
  if (isLocalFileMode()) {
    const store = await getStore();
    return resolveIdeaStages(await store.listIdeaStatuses())[0]!.key;
  }
  const db = getDb();
  if (!db) throw new Error("No database configured for portal intake.");
  const rows = await db
    .select({
      key: ideaStatuses.key,
      label: ideaStatuses.label,
      position: ideaStatuses.position,
    })
    .from(ideaStatuses)
    .where(eq(ideaStatuses.workspaceId, workspaceId))
    .orderBy(ideaStatuses.position);
  // `resolveIdeaStages` falls back to the built-in workflow below two rows,
  // the same rule the rest of the app applies, so a workspace that never
  // customised its stages gets `new` rather than nothing.
  return resolveIdeaStages(rows)[0]!.key;
}
