import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PortalShell } from "@/components/portal/portal-shell";
import { PUBLIC_PHASE_LABEL, readPortalRoadmap } from "@/lib/portal/roadmap";
import type { PortalRelease } from "@/lib/portal/roadmap";
import { portalShowsIdeas, resolvePortal } from "@/lib/portal/resolve";

/**
 * The public roadmap: `/{org}/roadmap`.
 *
 * ── Its own top-level route, not a child of `/ideas` ───────────────────────
 * The two surfaces answer different questions ("what do you want?" and "what
 * are you doing?"), a workspace can publish either without the other, and
 * `/{org}/roadmap` is the URL somebody would guess. The price is one more
 * reserved product key, which is paid in `RESERVED_PRODUCT_KEYS`: a static
 * child of `[org]` shadows any product with the same key, and a test asserts
 * every one of them is reserved.
 *
 * Two other places had to learn about it, and both would have failed quietly:
 * `isPortalPath` in middleware, or the page renders inside the app's sidebar
 * chrome and runs the session queries the portal branch exists to skip; and
 * `PORTAL_PATHS` in `portal-auth-isolation.test.ts`, or this route is simply
 * not covered by the rule that a portal page cannot read the session.
 *
 * ── This page must never read the session ──────────────────────────────────
 * Same rule as the ideas pages. Everything comes from `resolvePortal` and
 * `readPortalRoadmap`, both on the portal connection where RLS refuses
 * everything unless the roadmap switch is on.
 */

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ org: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { org } = await params;
  const portal = await resolvePortal(org);
  if (!portal || !portal.settings.portalRoadmapEnabled) {
    return { title: "Not found", robots: { index: false } };
  }
  return {
    title: `Roadmap · ${portal.title}`,
    description: `What ${portal.title} is building, and what has shipped.`,
    robots: { index: true, follow: true },
  };
}

export default async function PortalRoadmapPage({ params }: Params) {
  const { org } = await params;
  const portal = await resolvePortal(org);
  if (!portal) notFound();
  // The roadmap is gated separately from the ideas portal, because wanting
  // feedback in the open is not the same decision as publishing what you plan
  // to build and when (migration 0008). A portal with the roadmap switched off
  // has no page here at all, rather than an empty one.
  if (!portal.settings.portalRoadmapEnabled) notFound();

  const { shipped, upcoming } = await readPortalRoadmap(portal);

  return (
    <PortalShell title={portal.title} subtitle="Roadmap">
      <div className="space-y-8">
        {portalShowsIdeas(portal.settings) ? (
          <Link
            href={`/${portal.orgSlug}/ideas`}
            className="inline-block text-sm text-link hover:underline"
          >
            Suggest an idea
          </Link>
        ) : null}

        {shipped.length === 0 && upcoming.length === 0 ? (
          // Every list defaults to empty, so a roadmap switched on before its
          // statuses are chosen is unfinished rather than broken. A visitor
          // should not be shown a failure for somebody else's half-done
          // configuration.
          <p className="text-sm text-muted-foreground">
            There is nothing published here yet. Please check back soon.
          </p>
        ) : (
          <>
            <Section
              heading="Coming up"
              empty="Nothing is scheduled publicly at the moment."
              releases={upcoming}
              dateOf={(r) => r.targetDate}
              dateLabel="Targeting"
            />
            <Section
              heading="Shipped"
              empty="Nothing has shipped publicly yet."
              releases={shipped}
              dateOf={(r) => r.shippedDate ?? r.targetDate}
              dateLabel="Shipped"
            />
          </>
        )}
      </div>
    </PortalShell>
  );
}

function Section({
  heading,
  empty,
  releases,
  dateOf,
  dateLabel,
}: {
  heading: string;
  empty: string;
  releases: PortalRelease[];
  dateOf: (r: PortalRelease) => string | null;
  dateLabel: string;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold tracking-tight">{heading}</h2>
      {releases.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-4">
          {releases.map((release) => {
            const date = dateOf(release);
            return (
              <li key={release.id} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="font-medium">{release.name}</h3>
                  {date ? (
                    <p className="text-xs text-muted-foreground">
                      {dateLabel} {formatDate(date)}
                    </p>
                  ) : null}
                </div>
                <ul className="mt-3 space-y-2">
                  {release.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"
                    >
                      <span>{item.title}</span>
                      <span className="rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {item.levelLabel}
                      </span>
                      {/* The coarse phase, never the workspace's own stage
                          name. See `publicPhase`. */}
                      <span className="text-xs text-muted-foreground">
                        {PUBLIC_PHASE_LABEL[item.phase]}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * A date-only string as a readable date.
 *
 * Parsed as UTC explicitly. These columns are date-only text (`2026-09-13`),
 * and `new Date("2026-09-13")` is already UTC midnight, so a viewer west of
 * Greenwich rendering it in local time sees the day before. On a roadmap that
 * is a shipping date silently off by one.
 */
function formatDate(value: string): string {
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}
