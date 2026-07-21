import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { orgPath } from "@/lib/org-path";
import { currentOrgSlug } from "@/lib/workspace-access";

/**
 * The board/roadmap "no specs yet" empty state. Wraps {@link EmptyState} with
 * copy specific to Specboards' git-native model and, for admins who can connect
 * a repo, a CTA to the repositories settings. Async because it resolves the
 * org slug for that link; used only in server components.
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
}: {
  canConnect?: boolean;
  /** `"inline"` renders compact, for placement above an otherwise-empty
   * board whose structure (e.g. release columns) should stay visible. */
  variant?: "card" | "inline";
  className?: string;
}) {
  const reposHref = orgPath(await currentOrgSlug(), "/settings/repositories");
  return (
    <EmptyState
      variant={variant}
      className={className}
      title="No specs yet"
      description={
        canConnect
          ? "Specboards fills this board from specs/**/spec.md files in a connected GitHub repository. Connect the repo where your specs live and every spec imports automatically, staying in sync on each push."
          : "Specboards fills this board from specs/**/spec.md files in a connected GitHub repository. Once an admin connects the repo where your specs live, features appear here automatically."
      }
      action={
        canConnect ? (
          <Link href={reposHref} className={buttonVariants({ size: "sm" })}>
            Connect a repository
          </Link>
        ) : null
      }
    />
  );
}
