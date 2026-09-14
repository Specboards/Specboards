import { NextResponse } from "next/server";

import { recordPortalUnsubscribe } from "@/lib/portal-intake/unsubscribe";
import { portalShowsIdeas, resolvePortal } from "@/lib/portal/resolve";
import { readPortalUnsubscribeToken } from "@/lib/portal/vote-token";

/**
 * Where a portal unsubscribe link lands: `/{org}/ideas/unsubscribe?t=...`.
 *
 * ── One click, and it must always work ─────────────────────────────────────
 * The same promise `app/unsubscribe/page.tsx` makes for account holders, and
 * for the same reason: a refused unsubscribe is what turns "unsubscribe me"
 * into "mark as spam", which costs the whole deployment its sending reputation
 * rather than costing us one recipient. So the token never expires, and the
 * link records the opt-out rather than showing a confirm button.
 *
 * A link-scanning mail gateway can therefore unsubscribe somebody by fetching
 * the URL. That is the accepted cost of one-click, it is the same trade the
 * account unsubscribe makes, and it fails in the safe direction: the worst case
 * is somebody stops receiving optional mail they can start again by voting or
 * submitting from a portal that has not been unsubscribed.
 *
 * ── Why a route handler rather than a page ─────────────────────────────────
 * It redirects to the ideas list with `?unsubscribed=1`, so the reader lands
 * somewhere real instead of on a dead end. A page could render the outcome but
 * the vote confirmation next door already established the redirect shape, and
 * two landing pages that behave differently for no reason is worse than one.
 *
 * ── The write is on the owner connection, from `lib/portal-intake` ─────────
 * Deliberately, and matching what the account unsubscribe does: this request
 * carries no session, the signed token IS the authorization, and the portal
 * role is SELECT-only by design. It goes through `recordPortalUnsubscribe`
 * rather than reaching for the connection here, because `lib/portal` and this
 * route tree are the read side and the guard says so.
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
  const back = new URL(`/${portal.orgSlug}/ideas`, base);

  const token = new URL(req.url).searchParams.get("t");
  const claim = token ? readPortalUnsubscribeToken(token) : null;

  // One outcome for a forged token and a malformed one, as everywhere else on
  // this surface.
  if (!claim) {
    back.searchParams.set("unsubscribed", "invalid");
    return NextResponse.redirect(back);
  }

  // The token names its own workspace, and it must be THIS one. Without this a
  // link minted for one customer's portal would record an opt-out under
  // whichever org slug the URL happened to carry, which is both wrong and a way
  // to write a row into a workspace the reader has no relationship with.
  if (claim.workspaceId !== portal.workspaceId) {
    back.searchParams.set("unsubscribed", "invalid");
    return NextResponse.redirect(back);
  }

  try {
    await recordPortalUnsubscribe(claim.workspaceId, claim.email);
  } catch (err) {
    // Logged and reported as a failure rather than swallowed. Everywhere else
    // on this surface a failed write is a courtesy lost; here it means the
    // person asked to stop receiving mail and we did not record it, which is
    // the one failure that must not look like success.
    console.error("[portal-notify] recording an opt-out failed:", err);
    back.searchParams.set("unsubscribed", "failed");
    return NextResponse.redirect(back);
  }

  back.searchParams.set("unsubscribed", "1");
  return NextResponse.redirect(back);
}
