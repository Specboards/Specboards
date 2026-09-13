import { NextResponse } from "next/server";

import { portalShowsIdeas, resolvePortal } from "@/lib/portal/resolve";
import { recordPortalVote } from "@/lib/portal-intake/vote";
import {
  mintVoterCookie,
  readVoteToken,
  VOTER_COOKIE,
  VOTER_COOKIE_TTL_SEC,
} from "@/lib/portal/vote-token";

/**
 * Where a "confirm your vote" link lands: `GET /{org}/ideas/vote?t=...`.
 *
 * ── Why a route handler and not a page ─────────────────────────────────────
 * Because it has to set a cookie, and a Server Component cannot: Next refuses
 * with "Cookies can only be modified in a Server Action or Route Handler". The
 * first version of this WAS a page, and it rendered a 500 on every
 * confirmation. Nothing caught it but opening the link.
 *
 * So it records the vote, sets the cookie on the redirect, and sends the
 * visitor to the idea they voted for with `?voted=` saying what happened. That
 * is better than the page it replaced anyway: they land on the thing they came
 * for, with the new count already on it, rather than on a dead-end
 * confirmation screen with a link back.
 *
 * ── Why the link itself votes, rather than showing a confirm button ────────
 * The same reasoning `app/unsubscribe/page.tsx` sets out, and the same
 * trade-off. The email promises "open this link to count your vote", and a
 * confirmation step makes that two clicks for somebody who has already decided
 * twice.
 *
 * The cost is that a link-scanning mail gateway can trip it by fetching the
 * URL. Here that is benign: the vote it casts is the one the person asked for,
 * on the idea they chose, and the operation is idempotent, so a scanner and the
 * recipient between them still produce exactly one vote.
 *
 * ── Why this write path is under the portal route tree ─────────────────────
 * `portal-auth-isolation.test.ts` describes the portal's write paths as living
 * in `app/api/portal/` and `lib/portal-intake/`, and this is the exception,
 * deliberately. The URL goes in an email, where people read it before they
 * click; `/{org}/ideas/vote` is legible and `/api/portal/{org}/vote-confirm` is
 * not. The guard still scans this file for the forbidden names, and it passes:
 * everything it does goes through `resolvePortal` and `recordPortalVote`.
 */

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ org: string }> },
) {
  const { org } = await params;
  const portal = await resolvePortal(org);
  if (!portal || !portalShowsIdeas(portal.settings)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const base = new URL(req.url).origin;
  const list = new URL(`/${portal.orgSlug}/ideas`, base);
  const back = (ideaId: string, state: string) => {
    const url = new URL(`/${portal.orgSlug}/ideas/${ideaId}`, base);
    url.searchParams.set("voted", state);
    return url;
  };

  // One outcome for a forged token, a tampered one and an expired one:
  // `readVoteToken` returns the same null for all three, so nothing here can
  // tell a visitor (or a prober) which it was.
  const token = new URL(req.url).searchParams.get("t");
  const claim = token ? readVoteToken(token) : null;
  if (!claim) {
    list.searchParams.set("voted", "invalid");
    return NextResponse.redirect(list);
  }

  const result = await recordPortalVote(portal, claim.ideaId, claim.email);
  if (!result.ok) {
    // Public when the mail went out, not public now: withdrawn by a moderator,
    // moved to an unpublished stage, or its product unpublished. The idea page
    // would 404, so this goes back to the list rather than to a dead link.
    list.searchParams.set("voted", "gone");
    return NextResponse.redirect(list);
  }

  const res = NextResponse.redirect(
    back(claim.ideaId, result.alreadyVoted ? "already" : "counted"),
  );

  // Remember the confirmed address so the next vote is one click. `httpOnly`
  // so page scripts cannot read the address back out, and `lax` because the
  // visitor is arriving by following a link from their mail client: a `strict`
  // cookie would not be sent on that navigation, which is the one navigation
  // that has to set it.
  const cookie = mintVoterCookie(portal.workspaceId, claim.email);
  if (cookie) {
    res.cookies.set(VOTER_COOKIE, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: VOTER_COOKIE_TTL_SEC,
    });
  }
  return res;
}
