import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { IdeaList } from "@/components/portal/idea-list";
import { IdeaSubmit } from "@/components/portal/idea-submit";
import { PortalShell } from "@/components/portal/portal-shell";
import { listPortalIdeas, listPortalProducts } from "@/lib/portal/ideas";
import { portalShowsIdeas, resolvePortal } from "@/lib/portal/resolve";

/**
 * The public Ideas portal: `/{org}/ideas`.
 *
 * ── This page must never read the session ──────────────────────────────────
 * It shares an origin with the authenticated app, so a signed-in visitor's
 * cookie arrives with every request here. Nothing may act on it. In particular
 * this file, and everything it reaches, must not touch
 * `requireWorkspaceAccess`, `getStore` for tenant data, `getAppDb` or `getDb`:
 * all of those either demand a membership the visitor has not got, or read on a
 * connection that bypasses row-level security.
 *
 * The rule is not a convention here. `portal-auth-isolation.test.ts` reads this
 * directory and fails if any of those names appear in it, because the earlier
 * subdomain design enforced it structurally and a path-based portal has to
 * assert what the origin boundary used to give for free.
 *
 * Everything published flows from `resolvePortal` and the read model in
 * `lib/portal/ideas.ts`, both of which read on the portal connection where RLS
 * already limits rows to what the workspace publishes.
 */

/**
 * Dynamic, for two independent reasons, either of which would be enough.
 *
 * This page reads `?status=`, and a page that reads `searchParams` cannot hold
 * a full route cache entry. Separately, and more decisively, NO page in this
 * app can: the root layout awaits `headers()` for the per-request CSP nonce,
 * which opts the whole route tree out. See the note on `[ideaId]/page.tsx`,
 * which is where the card's "server-render and cache" instruction runs out.
 *
 * The filter could have been kept out of the URL to remove the first reason,
 * and that trade is the wrong way round anyway: a filtered view is something a
 * visitor links to, a crawler follows, and the back button should return to,
 * and none of that survives moving the filter into React state.
 *
 * What is left uncached is two indexed queries on the portal pool.
 */
export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ status?: string; voted?: string }>;
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string }>;
}): Promise<Metadata> {
  const { org } = await params;
  const portal = await resolvePortal(org);
  // No title for a portal that does not exist, and deliberately nothing that
  // distinguishes "no such workspace" from "not published": metadata is served
  // before the 404 and would otherwise answer the question the page refuses to.
  if (!portal) return { title: "Not found", robots: { index: false } };

  return {
    title: `Ideas · ${portal.title}`,
    description: `Browse and vote on ideas for ${portal.title}.`,
    // A published portal is meant to be found. Unpublished ones never reach
    // here, and `app/robots.ts` keeps crawlers off the authenticated app.
    robots: { index: true, follow: true },
  };
}

export default async function PortalIdeasPage({
  params,
  searchParams,
}: Params) {
  const { org } = await params;
  const portal = await resolvePortal(org);
  // One 404 for every reason. See `resolvePortal`: the cases are not
  // distinguishable here even on purpose, because an unpublished workspace is
  // not a row the portal connection can see.
  if (!portal) notFound();

  if (!portalShowsIdeas(portal.settings)) {
    // Not an error. Everything defaults to publishing nothing, so a portal
    // switched on before its products and stages are chosen is unfinished
    // rather than broken, and a visitor should not be shown a failure for
    // somebody else's half-done configuration.
    return (
      <PortalShell title={portal.title}>
        <p className="text-sm text-muted-foreground">
          There is nothing published here yet. Please check back soon.
        </p>
      </PortalShell>
    );
  }

  const [{ ideas, stages }, products] = await Promise.all([
    listPortalIdeas(portal),
    listPortalProducts(portal),
  ]);

  // A `?status=` naming a stage this portal does not publish is treated as no
  // filter at all, rather than as an empty result. The query string is
  // attacker-controlled and the alternative answers a question: "no ideas at
  // this status" for an unpublished stage confirms the stage exists, where
  // falling back to the full list says nothing either way.
  const search = await searchParams;
  const requested = search.status ?? null;
  const activeStatus =
    requested && stages.some((s) => s.key === requested) ? requested : null;

  return (
    <PortalShell title={portal.title}>
      <div className="space-y-6">
        {/* The two vote outcomes that have no idea page to land on: a token
            that did not verify, and an idea that stopped being public between
            the mail going out and the link being opened. */}
        {search.voted === "invalid" || search.voted === "gone" ? (
          <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
            {search.voted === "invalid"
              ? "That confirmation link is not valid. It may have expired, or been copied incompletely. Vote again below to get a new one."
              : "That idea is no longer public, so nothing was recorded."}
          </p>
        ) : null}

        {/* Above the list, because suggesting is the action a visitor arrives
            wanting to take, and below nothing, because reading what is already
            there should come first and often replaces the suggestion. */}
        <IdeaSubmit orgSlug={portal.orgSlug} products={products} />
        <IdeaList
          orgSlug={portal.orgSlug}
          ideas={
            activeStatus
              ? ideas.filter((i) => i.status === activeStatus)
              : ideas
          }
          stages={stages}
          activeStatus={activeStatus}
        />
      </div>
    </PortalShell>
  );
}
