import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PortalShell } from "@/components/portal/portal-shell";
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
 * Everything published flows from `resolvePortal`, which reads on the portal
 * connection where RLS already limits rows to what the workspace publishes.
 */

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ org: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
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

export default async function PortalIdeasPage({ params }: Params) {
  const { org } = await params;
  const portal = await resolvePortal(org);
  // One 404 for every reason. See `resolvePortal`: the cases are not
  // distinguishable here even on purpose, because an unpublished workspace is
  // not a row the portal connection can see.
  if (!portal) notFound();

  return (
    <PortalShell title={portal.title}>
      {portalShowsIdeas(portal.settings) ? (
        // The ideas list itself is the next card. Until it lands the shell is
        // deliberately honest about being empty rather than pretending.
        <p className="text-sm text-muted-foreground">
          Ideas are coming to this portal shortly.
        </p>
      ) : (
        // Not an error. Everything defaults to publishing nothing, so a portal
        // switched on before its products and stages are chosen is unfinished
        // rather than broken, and a visitor should not be shown a failure for
        // somebody else's half-done configuration.
        <p className="text-sm text-muted-foreground">
          There is nothing published here yet. Please check back soon.
        </p>
      )}
    </PortalShell>
  );
}
