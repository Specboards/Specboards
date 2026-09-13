import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { VoteButton } from "@/components/portal/vote-button";
import { PortalShell } from "@/components/portal/portal-shell";
import { readPortalIdea } from "@/lib/portal/ideas";
import { portalShowsIdeas, resolvePortal } from "@/lib/portal/resolve";

/**
 * One published idea: `/{org}/ideas/{ideaId}`.
 *
 * ── This claims the one dynamic slot under `/ideas`, on purpose ────────────
 * #467 reserved the `ideas` product key while "reworking the public portal's
 * routing, which moves to /{org}/ideas/{product}", so a per-product portal view
 * was once expected to sit exactly here. Both cannot: `[ideaId]` and
 * `[product]` are the same route to Next, and disambiguating them at runtime
 * would mean guessing whether a segment is a uuid or a product key, on the one
 * surface where guessing wrong serves the wrong workspace's content.
 *
 * The detail view gets the slot because it is the page a shared link points at
 * and the one a crawler indexes. A product view, if it is wanted, becomes
 * `?product=` on the list, which is where `?status=` already lives and reads
 * consistently with it. Nothing today publishes per-product portal URLs, so no
 * link breaks either way.
 *
 * ── This page must never read the session ──────────────────────────────────
 * Same rule as the list, and asserted the same way by
 * `portal-auth-isolation.test.ts`: it shares an origin with the authenticated
 * app, a signed-in visitor's cookie arrives with every request, and nothing
 * here may act on it. Everything shown flows from `resolvePortal` and
 * `readPortalIdea`, both on the portal connection.
 */

/**
 * Dynamic, like every other page in this app, and NOT for a reason local to
 * this file.
 *
 * The card asked for the public pages to be server-rendered and cached. They
 * cannot be, and the reason is `app/layout.tsx`: the root layout awaits
 * `headers()` to read the per-request CSP nonce, and middleware sets a second
 * header (`x-portal-route`) that it also reads. A layout that reads headers
 * opts every route beneath it out of the full route cache, so there is no page
 * in this application that holds a cache entry today.
 *
 * That is worth stating here rather than leaving as a surprise, because the
 * alternative is what the first draft of this file did: set `revalidate = 60`,
 * add the route to `revalidateIdeaPages`, and ship three pieces of machinery
 * that read as a caching strategy and do nothing at all. Verified against a
 * production build: every response, on this route and on `/sign-in` alike,
 * carries `Cache-Control: private, no-cache, no-store` and no
 * `x-nextjs-cache` header.
 *
 * Making the portal cacheable is a real change and a worthwhile one (it is the
 * page a launch link points a crowd at), but it means giving the portal branch
 * a nonce-free layout, which touches the app's CSP. That is its own card, not a
 * side effect of the read model.
 *
 * `force-dynamic` is therefore declared rather than inherited: it is what
 * actually happens, and saying so keeps the next reader from adding a
 * `revalidate` that would quietly do nothing.
 */
export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ org: string; ideaId: string }>;
  searchParams: Promise<{ voted?: string }>;
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; ideaId: string }>;
}): Promise<Metadata> {
  const { org, ideaId } = await params;
  const portal = await resolvePortal(org);
  if (!portal || !portalShowsIdeas(portal.settings)) {
    return { title: "Not found", robots: { index: false } };
  }
  const idea = await readPortalIdea(portal, ideaId);
  // Metadata is served before the 404, so it must be as silent as the page
  // about why: a title here for an idea the page refuses to render would answer
  // the question the 404 declines to.
  if (!idea) return { title: "Not found", robots: { index: false } };

  return {
    title: `${idea.title} · ${portal.title}`,
    // The submitter's own words, trimmed. Nothing internal: the description is
    // the only free text on the projection, by design.
    description: idea.description?.slice(0, 200) ?? undefined,
    robots: { index: true, follow: true },
  };
}

export default async function PortalIdeaDetailPage({
  params,
  searchParams,
}: Params) {
  const { org, ideaId } = await params;
  const portal = await resolvePortal(org);
  if (!portal) notFound();
  // A portal publishing no ideas has no idea pages either, and this keeps the
  // two routes agreeing about that rather than letting a direct link reach a
  // detail page the list would never have shown.
  if (!portalShowsIdeas(portal.settings)) notFound();

  const idea = await readPortalIdea(portal, ideaId);
  // One 404 for "no such idea" and for "that idea is not published", and the
  // read model cannot tell them apart even deliberately. Ids are guessable in
  // bulk, and a route that answered differently would confirm which of them
  // name real internal ideas.
  if (!idea) notFound();

  // Set by the confirmation link's redirect. Only the two outcomes that land
  // HERE are handled; "invalid" and "gone" redirect to the list instead,
  // because in both of those cases there is no idea page to land on.
  const voted = (await searchParams).voted;

  return (
    <PortalShell title={portal.title}>
      <div className="space-y-6">
        {voted === "counted" || voted === "already" ? (
          <p className="rounded-md border border-link/40 bg-link/5 px-4 py-3 text-sm">
            {voted === "counted"
              ? "Your vote is counted. You will not need to confirm again on this device for a while."
              : "You had already voted for this. Votes are one per person, so nothing changed."}
          </p>
        ) : null}
        <Link
          href={`/${portal.orgSlug}/ideas`}
          className="inline-block text-sm text-muted-foreground hover:underline"
        >
          &larr; All ideas
        </Link>

        <article className="flex gap-4">
          <VoteButton
            orgSlug={portal.orgSlug}
            ideaId={idea.id}
            count={idea.voteCount}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold tracking-tight">
              {idea.title}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {idea.statusLabel}
              {idea.submitterName ? ` · Suggested by ${idea.submitterName}` : ""}
            </p>
            {idea.description ? (
              // Plain text in a preserving wrapper, not rendered Markdown.
              //
              // The body of a public idea is attacker-supplied on any portal
              // that accepts submissions, and a Markdown renderer on the one
              // page served to strangers is a surface worth not having for the
              // sake of italics. Whether the internal board's Markdown should
              // reach the portal at all is a question for the submission card,
              // which is what starts writing these bodies from outside.
              <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">
                {idea.description}
              </p>
            ) : null}
          </div>
        </article>
      </div>
    </PortalShell>
  );
}
