import { cookies } from "next/headers";

import { readJsonBody } from "@/lib/api/body";
import { rateLimitKey } from "@/lib/client-ip";
import { getDb } from "@/lib/db";
import { renderInfoEmail, sendEmail } from "@/lib/email";
import { mailStatus } from "@/lib/mail/send";
import { readPortalIdea } from "@/lib/portal/ideas";
import { portalShowsIdeas, resolvePortal } from "@/lib/portal/resolve";
import { recordPortalVote } from "@/lib/portal-intake/vote";
import {
  mintVoteToken,
  readVoterCookie,
  VOTER_COOKIE,
} from "@/lib/portal/vote-token";
import { QUOTAS, enforceQuota } from "@/lib/rate-limit";

/**
 * Vote on a published idea: `POST /api/portal/{org}/ideas/{ideaId}/vote`.
 *
 * Two ways in, and which one a visitor gets is the whole design of this
 * endpoint.
 *
 * ── First vote: an emailed link ────────────────────────────────────────────
 * The visitor gives an address and gets a link. Clicking it records the vote.
 * That was chosen over a cookie-only or captcha scheme because it buys a demand
 * signal worth acting on and a contactable voter list, at the cost of mail on
 * the voting path.
 *
 * Nothing is written here. A request that wrote a provisional row would let
 * anybody inflate a count with addresses they do not control, which is the
 * exact thing the mail round trip is paid for.
 *
 * ── Later votes: the cookie from that confirmation ─────────────────────────
 * Once an address is confirmed, a signed 30-day cookie records it and
 * subsequent votes are one click. That makes the verification a one-time
 * formality per browser, which is the point: a portal where every vote costs an
 * email round trip collects one vote per person and no more.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 * No CORS and no CSRF exemption: same origin as the portal page, so the check
 * passes on its own. See the intake route for why an exemption that buys
 * nothing is surface area.
 *
 * No un-vote. Removing a vote needs the same proof of identity as casting one,
 * and the honest version is a link in the confirmation mail rather than a
 * button that trusts whatever cookie the browser happens to hold. Not built
 * because nothing asked for it, and worth being explicit that its absence is a
 * decision.
 */

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ org: string; ideaId: string }> },
) {
  const { org, ideaId } = await params;

  const portal = await resolvePortal(org);
  if (!portal || !portalShowsIdeas(portal.settings)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  // The idea must be one this portal actually publishes. Checked before
  // anything else so a probe for internal ids costs the same 404 whether or not
  // the id names a real row, and so no mail is ever sent about one.
  const idea = await readPortalIdea(portal, ideaId);
  if (!idea) return Response.json({ error: "Not found." }, { status: 404 });

  // ── The confirmed path ───────────────────────────────────────────────────
  // A signed cookie from an earlier confirmation. Scoped to this workspace, so
  // a confirmation earned on one customer's portal does not identify the
  // visitor on another's.
  const jar = await cookies();
  const cookieValue = jar.get(VOTER_COOKIE)?.value;
  const confirmed = cookieValue
    ? readVoterCookie(cookieValue, portal.workspaceId)
    : null;

  if (confirmed) {
    const result = await recordPortalVote(portal, ideaId, confirmed);
    if (!result.ok) return Response.json({ error: "Not found." }, { status: 404 });
    return Response.json({ ok: true, counted: true, alreadyVoted: result.alreadyVoted });
  }

  // ── The first-vote path ──────────────────────────────────────────────────
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const body = parsed.body as Record<string, unknown>;

  const raw = typeof body.email === "string" ? body.email.trim() : "";

  // No cookie and no address offered: the visitor clicked Vote without ever
  // having confirmed one. That is the normal first visit, not an error, so it
  // answers with what the client needs to do rather than a 400 it would have
  // to interpret.
  //
  // Answered the same way whether or not a cookie exists for a DIFFERENT
  // workspace, and the cookie is `httpOnly`, so page scripts cannot learn from
  // this whether the visitor has confirmed an address elsewhere.
  if (!raw) return Response.json({ ok: true, needsEmail: true });

  const email = raw.slice(0, 320).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return Response.json(
      { error: "A valid email address is required." },
      { status: 400 },
    );
  }

  // Both quotas, after validation so a malformed request does not spend one,
  // and before sending so they are what bounds the mail. Per client caps one
  // source hammering the endpoint; per email caps a distributed mailbomb aimed
  // at one person, which the per-client limit cannot see. Where the client
  // cannot be identified `rateLimitKey` falls back to a single shared bucket
  // rather than handing every request a fresh one.
  const db = getDb();
  if (db) {
    const perClient = await enforceQuota(
      db,
      QUOTAS.portalVote,
      rateLimitKey(req, "portal-vote"),
    );
    if (perClient) {
      return Response.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 },
      );
    }
    if (await enforceQuota(db, QUOTAS.portalVoteEmail, email)) {
      return Response.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 },
      );
    }
  }

  // Voting is a mail feature, so a deployment with no transport cannot offer
  // it. Found by watching the real thing: without this the endpoint answers
  // `sent: true`, the visitor is told to check their email, and the log quietly
  // says "no transport configured; dropping". `sendEmail` does not throw in
  // that case (deliberately, see `lib/mail/send.ts`), so nothing downstream
  // notices, and the vote is never recorded.
  //
  // `mailStatus()` rather than `isEmailConfigured()`: the latter reads env only
  // and would report "unavailable" for a self-hoster who configured SMTP in
  // Settings, which is a supported way to have working mail.
  if (!(await mailStatus()).configured) {
    return Response.json(
      {
        error:
          "Voting needs email, which is not set up on this site yet. Please try again later.",
      },
      { status: 503 },
    );
  }

  const token = mintVoteToken({ ideaId, email });
  if (!token) {
    // No signing secret. The feature is unavailable rather than broken, and
    // saying so beats a 500 in front of somebody trying to vote.
    console.error("[portal-vote] BETTER_AUTH_SECRET is unset; cannot mint");
    return Response.json(
      { error: "Voting is unavailable on this portal." },
      { status: 503 },
    );
  }

  const base = (process.env.APP_URL ?? new URL(req.url).origin).replace(
    /\/$/,
    "",
  );
  const link = `${base}/${encodeURIComponent(org)}/ideas/vote?t=${encodeURIComponent(token)}`;

  try {
    const mail = renderInfoEmail({
      intro: [
        `Confirm your vote for "${idea.title}" on ${portal.title}.`,
        `Open this link to count your vote: ${link}`,
        "The link works for 30 minutes. If you did not ask to vote, ignore this email and nothing will happen.",
      ],
      footer: `You are receiving this because somebody entered this address to vote at ${portal.title}.`,
    });
    await sendEmail({
      to: email,
      subject: `Confirm your vote on ${portal.title}`,
      textBody: mail.textBody,
      htmlBody: mail.htmlBody,
    });
  } catch (err) {
    console.error("[portal-vote] send failed", err);
    return Response.json(
      { error: "We could not send the confirmation. Please try again." },
      { status: 502 },
    );
  }

  // `sent`, not `counted`, so the client says "check your email" rather than
  // incrementing anything. Nothing has been written at this point, and that is
  // the property the mail round trip exists to preserve.
  return Response.json({ ok: true, sent: true });
}
