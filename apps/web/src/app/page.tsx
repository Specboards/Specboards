import { redirect } from "next/navigation";

import { ALL_PRODUCTS } from "@/lib/active-product";
import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { LOCAL_ORG_SLUG, orgProductPath } from "@/lib/org-path";
import { getWorkspaceById, resolveActiveWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Root redirect into the caller's active org. The bare `/` carries no org slug,
 * so we resolve the active workspace here and send the user to the all-products
 * backlog, `/{org}/all/backlog` (ADR 0001, D3/D5/D6). File mode uses the local
 * slug.
 */
export default async function HomePage() {
  const db = getDb();
  if (!db) redirect(orgProductPath(LOCAL_ORG_SLUG, ALL_PRODUCTS, "/backlog"));

  const user = await getServerSessionUser();
  if (!user) redirect("/sign-in");

  const membership = await resolveActiveWorkspace(db, user.id);
  if (!membership) redirect("/setup");

  const workspace = await getWorkspaceById(db, membership.workspaceId);
  redirect(orgProductPath(workspace?.slug ?? LOCAL_ORG_SLUG, ALL_PRODUCTS, "/backlog"));
}
