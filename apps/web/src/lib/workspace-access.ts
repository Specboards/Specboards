import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { LOCAL_ORG_SLUG } from "@/lib/org-path";
import { getStore } from "@/lib/store";
import type {
  ProductGroupRecord,
  ProductRecord,
  WorkspaceScope,
} from "@/lib/store/types";
import {
  getWorkspaceById,
  listMembershipsForUser,
  resolveActiveWorkspace,
  type MemberRole,
} from "@/lib/workspace";

/** Tenant scope, the caller's role, and the active org slug for a content page. */
export type PageAccess = WorkspaceScope & { role: MemberRole; orgSlug: string };

/**
 * Whether the viewer can connect a GitHub repository (owner-only). `null`
 * access is local file mode, where repo connection isn't a concept.
 */
export function canConnectRepos(access: PageAccess | null): boolean {
  return access?.role === "owner";
}

/**
 * Product-aware edit gate for already-loaded products (which carry
 * `viewerRole`). The workspace owner can edit anything; otherwise editing is a
 * per-product grant (`admin` or `contributor`). Pass a `productId` for a
 * single-product view, a set of ids for a group-scoped view (true when the
 * caller can edit any product in the set), or `null` for the cross-product
 * "all" view (true when the caller can edit *any* of `products`). `null`
 * access is local file mode (always editable). Reuses the `viewerRole` already
 * on each product, so no extra query — mirrors core `canWriteProduct`.
 */
export function canEditProducts(
  access: { role: MemberRole } | null,
  products: ProductRecord[],
  productId: string | ReadonlySet<string> | null,
): boolean {
  if (!access) return true;
  if (access.role === "owner") return true;
  const writable = (p: ProductRecord) =>
    p.viewerRole === "admin" || p.viewerRole === "contributor";
  if (typeof productId === "string") {
    return products.some((p) => p.id === productId && writable(p));
  }
  if (productId) return products.some((p) => productId.has(p.id) && writable(p));
  return products.some(writable);
}

/**
 * The signed-in user's orgs for the sidebar switcher. Returns `[]` when there's
 * nothing to switch between (no session, file mode, or a single org), so the
 * switcher stays hidden outside true multi-org membership.
 */
export async function listSidebarOrgs(): Promise<
  { slug: string; name: string }[]
> {
  const db = getDb();
  if (!db) return [];
  const user = await getServerSessionUser();
  if (!user) return [];
  const memberships = await listMembershipsForUser(db, user.id);
  if (memberships.length < 2) return [];
  const orgs = await Promise.all(
    memberships.map(async (m) => {
      const ws = await getWorkspaceById(db, m.workspaceId);
      return ws ? { slug: ws.slug, name: ws.name } : null;
    }),
  );
  return orgs.filter((o): o is { slug: string; name: string } => o !== null);
}

/**
 * Products of the active org, for the sidebar product switcher. Resolves the
 * org from the `x-org-slug` header (validated against membership), so it only
 * ever returns products the caller may see. `[]` outside an org context.
 */
export async function listSidebarProducts(): Promise<ProductRecord[]> {
  const db = getDb();
  const store = await getStore();
  if (!db) return store.listProducts(); // file mode, unscoped
  const user = await getServerSessionUser();
  if (!user) return [];
  const orgSlug = (await headers()).get("x-org-slug") || undefined;
  const membership = await resolveActiveWorkspace(db, user.id, { orgSlug });
  if (!membership) return [];
  return store.listProducts({
    userId: user.id,
    workspaceId: membership.workspaceId,
  });
}

/**
 * Product groups of the active org, for the sidebar switcher and group-scoped
 * pages. Same org resolution as `listSidebarProducts`. Returns every group in
 * the workspace (metadata is member-visible); callers hide groups without
 * readable products where that matters.
 */
export async function listSidebarGroups(): Promise<ProductGroupRecord[]> {
  const db = getDb();
  const store = await getStore();
  if (!db) return store.listProductGroups(); // file mode, unscoped
  const user = await getServerSessionUser();
  if (!user) return [];
  const orgSlug = (await headers()).get("x-org-slug") || undefined;
  const membership = await resolveActiveWorkspace(db, user.id, { orgSlug });
  if (!membership) return [];
  return store.listProductGroups({
    userId: user.id,
    workspaceId: membership.workspaceId,
  });
}

/**
 * The active org slug for the current request, read from the `x-org-slug`
 * header set by middleware (the first URL path segment). Empty at the root
 * (`/`); falls back to the local slug in file mode. See ADR 0001 (D3).
 */
export async function currentOrgSlug(): Promise<string> {
  return (await headers()).get("x-org-slug") || LOCAL_ORG_SLUG;
}

/**
 * Page-level access gate for content routes (`/{org}/…`). When auth is enabled:
 * - no session              → redirect to /sign-in
 * - session, no workspace   → redirect to /setup (first user names the org)
 * - org slug not a member's → 404 (the URL is only a hint; authority is the
 *   validated membership — ADR 0001 D2/D3)
 *
 * Returns the tenant scope (+ role + org slug) to pass to the store, or `null`
 * in local file mode (auth disabled), where pages are ungated and unscoped.
 */
export async function requireWorkspaceAccess(): Promise<PageAccess | null> {
  const db = getDb();
  const user = await getServerSessionUser();
  if (!db) return null; // file mode, no auth, no gating
  if (!user) redirect("/sign-in");

  const orgSlug = (await headers()).get("x-org-slug") || undefined;
  const membership = await resolveActiveWorkspace(db, user.id, { orgSlug });
  if (!membership) {
    // A slug that names no org the caller belongs to → not found. No slug means
    // the bare root or first-run, which belongs at /setup.
    if (orgSlug) notFound();
    redirect("/setup");
  }

  const workspace = await getWorkspaceById(db, membership.workspaceId);
  return {
    userId: user.id,
    workspaceId: membership.workspaceId,
    role: membership.role,
    orgSlug: workspace?.slug ?? orgSlug ?? LOCAL_ORG_SLUG,
  };
}
