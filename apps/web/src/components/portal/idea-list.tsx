import Link from "next/link";

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
            <li key={idea.id}>
              <Link
                href={`${base}/${idea.id}`}
                className="flex gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/50"
              >
                <VoteCount n={idea.voteCount} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{idea.title}</p>
                  {idea.description ? (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {idea.description}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {idea.statusLabel}
                  </p>
                </div>
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

/**
 * The demand signal. Rendered as a labelled count rather than a bare number so
 * a screen reader gets "12 votes" instead of "12", which is meaningless beside
 * a title.
 */
export function VoteCount({ n }: { n: number }) {
  return (
    <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-md border">
      <span aria-hidden className="text-sm font-semibold tabular-nums">
        {n}
      </span>
      <span aria-hidden className="text-[10px] uppercase text-muted-foreground">
        {n === 1 ? "vote" : "votes"}
      </span>
      <span className="sr-only">
        {n} {n === 1 ? "vote" : "votes"}
      </span>
    </div>
  );
}
