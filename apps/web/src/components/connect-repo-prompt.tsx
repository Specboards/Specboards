import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { hasConnectedRepository } from "@/lib/first-run";
import { orgPath } from "@/lib/org-path";
import {
  canConnectRepos,
  currentOrgSlug,
  type PageAccess,
} from "@/lib/workspace-access";

/**
 * The next step a brand-new instance never named: connect a repository.
 *
 * A fresh install has an admin account, one product and nothing else. The
 * dashboard said "0 items" and the backlog offered exactly one action, "New
 * feature", which creates a DB-native card. So an operator could build a whole
 * board without ever discovering that specs exist or that a repository can be
 * connected, and then be told out of band that they had set it up wrong. For a
 * product whose premise is git-backed specs, the empty state pointed at the one
 * path that never involves git.
 *
 * The leaf board already offered this (`NoSpecsEmptyState`), but only there:
 * the levels above it, and the dashboard, said nothing. Those are where a new
 * operator actually lands.
 *
 * Shown only while the workspace has no repository at all, and only to someone
 * who could connect one. It disappears on the first connection, which follows
 * the convention in CLAUDE.md of revealing a setup affordance only while there
 * is setup to do. A workspace that deliberately never connects git keeps
 * seeing it; that is the deliberate trade, because the state it describes is
 * also exactly the state the bug report was about, and hiding it once a board
 * has items would hide it precisely when someone has gone furthest down the
 * wrong path.
 *
 * Renders nothing in local file mode, where specs come off the working tree
 * and there is no repository to connect.
 */
export async function ConnectRepoPrompt({
  access,
  className = "",
}: {
  access: PageAccess | null;
  className?: string;
}) {
  const db = getDb();
  if (!db || !access) return null;
  if (!canConnectRepos(access)) return null;
  if (await hasConnectedRepository(db, access.workspaceId)) return null;

  const href = orgPath(await currentOrgSlug(), "/settings/repositories");
  return (
    <section
      className={`rounded-lg border border-dashed p-4 ${className}`}
      aria-labelledby="connect-repo-prompt-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="connect-repo-prompt-title"
            className="text-sm font-medium"
          >
            Connect a repository to finish setting up
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Specboards imports <code>specs/**/spec.md</code> from a connected
            GitHub repository and keeps the board in sync on every push. Until
            one is connected, items here are cards in Specboards only, with no
            spec behind them.
          </p>
        </div>
        <Link
          href={href}
          className={buttonVariants({ size: "sm" })}
        >
          Connect a repository
        </Link>
      </div>
    </section>
  );
}
