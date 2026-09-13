import Link from "next/link";

import { VoteButton } from "@/components/portal/vote-button";
import type { PortalIdea, PortalStage } from "@/lib/portal/ideas";

/**
 * The published ideas, with their demand, and the filter over them.
 *
 * A server component with no client bundle. The status filter is a set of
 * links rather than a `<select>` with an `onChange`, which is not a purity
 * exercise: a filtered view is a thing a visitor will want to link someone to,
 * a crawler should be able to follow, and the back button should return to.
 * Doing it in the URL gets all three, and doing it in React state gets none.
 * It also keeps the rule this whole route tree is built on (a portal page ships
 * no interactivity it does not need) intact for free.
 */
export function IdeaList({
  orgSlug,
  ideas,
  stages,
  activeStatus,
}: {
  orgSlug: string;
  ideas: PortalIdea[];
  stages: PortalStage[];
  /** The stage being filtered to, or null for all of them. */
  activeStatus: string | null;
}) {
  const base = `/${orgSlug}/ideas`;

  return (
    <div className="space-y-6">
      {/* One stage is not a filter, it is a label, so do not render a chooser
          the visitor cannot use to change anything. */}
      {stages.length > 1 ? (
        <nav aria-label="Filter ideas by status">
          <ul className="flex flex-wrap gap-2">
            <FilterChip href={base} active={activeStatus === null}>
              All
            </FilterChip>
            {stages.map((s) => (
              <FilterChip
                key={s.key}
                href={`${base}?status=${encodeURIComponent(s.key)}`}
                active={activeStatus === s.key}
              >
                {s.label}
              </FilterChip>
            ))}
          </ul>
        </nav>
      ) : null}

      {ideas.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {activeStatus === null
            ? "There is nothing published here yet. Please check back soon."
            : "No ideas at this status yet."}
        </p>
      ) : (
        <ul className="space-y-3">
          {ideas.map((idea) => (
            // The vote control sits OUTSIDE the link, not inside it. A button
            // nested in an anchor is invalid HTML, and in practice a click on it
            // navigates to the detail page instead of voting, which is the bug
            // that shape always produces.
            <li
              key={idea.id}
              className="flex gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/50"
            >
              <VoteButton
                orgSlug={orgSlug}
                ideaId={idea.id}
                count={idea.voteCount}
              />
              <Link href={`${base}/${idea.id}`} className="min-w-0 flex-1">
                <p className="font-medium">{idea.title}</p>
                {idea.description ? (
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {idea.description}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  {idea.statusLabel}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        // `aria-current` rather than colour alone, so the active filter is
        // announced rather than merely shaded.
        aria-current={active ? "page" : undefined}
        className={
          active
            ? "inline-block rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
            : "inline-block rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
        }
      >
        {children}
      </Link>
    </li>
  );
}
