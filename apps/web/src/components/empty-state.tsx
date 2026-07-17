import Link from "next/link";
import type { ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { orgPath } from "@/lib/org-path";
import { cn } from "@/lib/utils";
import { currentOrgSlug } from "@/lib/workspace-access";

/**
 * A first-run / no-data empty state: a short block that says what belongs here
 * and offers one clear next step. Prefer this over a bare "Nothing here yet"
 * line so blank screens guide the user (see the empty-state UX rule in
 * CLAUDE.md). Pass the single primary next step as `action` - typically an
 * "Add X" button, an affordance that opens a form, or a link.
 *
 * `variant`:
 * - `"card"` (default): a bordered, centered card for a whole empty page/board.
 * - `"inline"`: a compact, borderless block for an empty list that already sits
 *   inside a settings card (so we don't nest a card in a card).
 *
 * Presentational and framework-neutral: no data fetching and no client hooks,
 * so it renders in both server and client components.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  variant = "card",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  variant?: "card" | "inline";
  className?: string;
}) {
  const body = (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
      {icon ? (
        <div
          className="text-muted-foreground [&>svg]:h-6 [&>svg]:w-6"
          aria-hidden
        >
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p
          className={cn(
            "font-medium",
            variant === "card" ? "text-base" : "text-sm",
          )}
        >
          {title}
        </p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );

  if (variant === "inline") {
    return <div className={cn("py-8", className)}>{body}</div>;
  }
  return (
    <Card className={cn("mx-auto max-w-lg", className)}>
      <CardContent className="py-10">{body}</CardContent>
    </Card>
  );
}

/**
 * The board/roadmap "no specs yet" empty state. Wraps {@link EmptyState} with
 * copy specific to Specboard's git-native model and, for admins who can connect
 * a repo, a CTA to the repositories settings. Async because it resolves the
 * org slug for that link; used only in server components.
 */
export async function NoSpecsEmptyState({
  canConnect = false,
}: {
  canConnect?: boolean;
}) {
  const reposHref = orgPath(await currentOrgSlug(), "/settings/repositories");
  return (
    <EmptyState
      className="mt-8"
      title="No specs yet"
      description={
        canConnect
          ? "Specboard fills this board from specs/**/spec.md files in a connected GitHub repository. Connect the repo where your specs live and every spec imports automatically, staying in sync on each push."
          : "Specboard fills this board from specs/**/spec.md files in a connected GitHub repository. Once an admin connects the repo where your specs live, features appear here automatically."
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
