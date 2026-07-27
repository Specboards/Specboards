import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { orgPath } from "@/lib/org-path";
import { currentOrgSlug } from "@/lib/workspace-access";

/**
 * The board/roadmap empty state for the leaf (work item) level. Work items
 * reach this level two ways: imported from `specs/**` in a connected repo, or
 * created here for work that has no spec (see ADR 0003). The copy names both,
 * and both CTAs render when the viewer can take them. Async because it resolves
 * the org slug for the repositories link; used only in server components.
 *
 * Kept in its own file (not alongside the presentational `EmptyState`) because
 * it reaches for `currentOrgSlug`, which imports server-only `next/headers`.
 * Co-locating it with `EmptyState` would drag that server import into every
 * client component that renders a plain empty state and break the build.
 */
export async function NoSpecsEmptyState({
  canConnect = false,
  variant = "card",
  className = "mt-8",
  createAction = null,
}: {
  canConnect?: boolean;
  /** `"inline"` renders compact, for placement above an otherwise-empty
   * board whose structure (e.g. release columns) should stay visible. */
  variant?: "card" | "inline";
  className?: string;
  /** The "New work item" control, when the viewer can create one. Rendered
   * first, since creating one here is the immediate action; connecting a repo
   * is the larger, one-time setup step. */
  createAction?: React.ReactNode;
}) {
  const reposHref = orgPath(await currentOrgSlug(), "/settings/repositories");
  const connectAction = canConnect ? (
    <Link
      href={reposHref}
      className={buttonVariants({
        size: "sm",
        variant: createAction ? "outline" : "default",
      })}
    >
      Connect a repository
    </Link>
  ) : null;
  return (
    <EmptyState
      variant={variant}
      className={className}
      title="No work items yet"
      description={
        canConnect
          ? "Work items come from specs/**/spec.md in a connected GitHub repository, importing automatically and staying in sync on each push. Work that has no spec, a task someone is doing by hand, can be added here directly."
          : "Work items come from specs/**/spec.md in a connected GitHub repository, importing automatically once an admin connects it. Work that has no spec can also be added here directly."
      }
      action={
        createAction || connectAction ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {createAction}
            {connectAction}
          </div>
        ) : null
      }
    />
  );
}
