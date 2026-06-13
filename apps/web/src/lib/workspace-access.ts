import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import type { WorkspaceScope } from "@/lib/store/types";
import { ensureMembership, type MemberRole } from "@/lib/workspace";

/** Tenant scope plus the caller's role, as resolved for a content page. */
export type PageAccess = WorkspaceScope & { role: MemberRole };

/**
 * Whether the viewer can connect a GitHub repository (admin-only). `null`
 * access is local file mode, where repo connection isn't a concept.
 */
export function canConnectRepos(access: PageAccess | null): boolean {
  return access?.role === "admin";
}

/**
 * Page-level access gate for content routes. When auth is enabled:
 * - no session            → redirect to /sign-in
 * - session, no workspace → redirect to /setup (first user names the org)
 * - session + workspace   → auto-join as viewer if needed, then proceed
 *
 * Returns the tenant scope to pass to the store, or `null` in local file mode
 * (auth disabled), where pages are ungated and the store is unscoped.
 */
export async function requireWorkspaceAccess(): Promise<PageAccess | null> {
  const db = getDb();
  const user = await getServerSessionUser();
  if (!db) return null; // file mode — no auth, no gating
  if (!user) redirect("/sign-in");

  const membership = await ensureMembership(db, user.id);
  if (!membership) redirect("/setup");

  return {
    userId: user.id,
    workspaceId: membership.workspaceId,
    role: membership.role,
  };
}
