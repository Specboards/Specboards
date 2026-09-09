import { eq, ideaPortalProducts, ideaSettings, workspaces } from "@specboards/db";

import { getPortalDb } from "@/lib/db";
import { isLocalFileMode } from "@/lib/local-mode";
import { LOCAL_ORG_SLUG } from "@/lib/org-path";
import { getStore } from "@/lib/store";
import { isPortalModeration, type IdeaSettings } from "@/lib/store/types";

/**
 * Resolving the workspace behind a portal URL, and nothing else.
 *
 * Every public page starts here, and this module is the reason they can be
 * written like ordinary pages afterwards. It is also the one place in the
 * portal that is allowed to know a workspace exists before knowing whether its
 * portal is published.
 *
 * ── Why this cannot use the app's helpers ──────────────────────────────────
 * `requireWorkspaceAccess()` resolves the org by validating a membership, which
 * a portal visitor does not have and must not need. `getWorkspaceBySlug` in
 * `lib/workspace.ts` runs on the owner connection, which bypasses RLS: it would
 * happily return a workspace whose portal is switched off, and then the only
 * thing standing between that row and a public page would be an `if` somebody
 * has to remember to write.
 *
 * ── The oracle problem, solved by the connection rather than by care ───────
 * A portal is addressed by workspace slug, so "does this slug exist" is a
 * question a stranger can ask repeatedly. Answering it differently for "no such
 * workspace" and "that workspace has no portal" turns the URL into a directory
 * of every company with an account.
 *
 * On `getPortalDb()` the distinction cannot be made even deliberately.
 * `workspaces_portal_select` (migration 0009) admits a row only while
 * `specboards_portal_published(id)` holds, so an unpublished workspace is not a
 * row this connection can see. Both cases return null here, from the same query
 * with no branch, which is a much stronger guarantee than remembering to return
 * the same 404 twice.
 */

/** A published portal: the workspace it belongs to, and what it may show. */
interface PortalContext {
  workspaceId: string;
  orgSlug: string;
  /** Heading for the portal, falling back to the workspace name. */
  title: string;
  settings: IdeaSettings;
}

/**
 * The published portal for `orgSlug`, or null when there is none.
 *
 * Null covers three cases on purpose and does not distinguish them: no such
 * workspace, a workspace whose portal is switched off, and a deployment with no
 * portal connection configured. Callers render the same 404 for all of them.
 */
export async function resolvePortal(
  orgSlug: string,
): Promise<PortalContext | null> {
  const slug = orgSlug.trim().toLowerCase();
  if (!slug) return null;

  // Local file mode has no Postgres, no auth and one workspace, and is bound to
  // loopback (see lib/local-mode.ts). There is no tenant to isolate from and no
  // RLS to enforce, so the portal reads the local store like everything else
  // does there. The publish switch is still honoured, because a self-hoster
  // previewing their portal should see what it will actually show.
  if (isLocalFileMode()) {
    // The slug still has to match. Local mode has exactly one workspace, on
    // `LOCAL_ORG_SLUG`, and the local store has no slug to filter by, so
    // without this check every URL served the portal: `/anything/ideas` was a
    // 200. Harmless in the sense that there is one tenant and nothing leaked
    // across, and wrong in the way that matters, because the route stopped
    // agreeing with the hosted one about what exists.
    if (slug !== LOCAL_ORG_SLUG) return null;
    const store = await getStore();
    const settings = await store.getIdeaSettings();
    if (!settings.portalEnabled) return null;
    return {
      workspaceId: slug,
      orgSlug: slug,
      title: settings.portalTitle?.trim() || slug,
      settings,
    };
  }

  const db = getPortalDb();
  // No portal connection: on a hosted deployment `getPortalDb()` has already
  // thrown rather than reach here, and on a self-host that has not provisioned
  // the role there is simply no portal. Either way, nothing to serve.
  if (!db) return null;

  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  // Unpublished workspaces are not rows this connection can see, so this single
  // check covers "no such org" and "portal disabled" without knowing which.
  if (!workspace) return null;

  // Read the settings here rather than through `store.getIdeaSettings()`.
  //
  // That helper runs on `getAppDb()` inside `asUser()`, whose policies key on
  // `app.user_id`. The portal has no user, so it would match no rows and return
  // the publishing-nothing defaults for EVERY workspace: not a leak, but every
  // portal would render empty and look broken, and the cause would be three
  // layers away from the symptom. The portal reads on the portal connection,
  // whose policies are the ones written for it.
  const [row] = await db
    .select({
      portalEnabled: ideaSettings.portalEnabled,
      portalTitle: ideaSettings.portalTitle,
      portalIdeaStatuses: ideaSettings.portalIdeaStatuses,
      portalRoadmapEnabled: ideaSettings.portalRoadmapEnabled,
      portalRoadmapItemStatuses: ideaSettings.portalRoadmapItemStatuses,
      portalModeration: ideaSettings.portalModeration,
    })
    .from(ideaSettings)
    .where(eq(ideaSettings.workspaceId, workspace.id))
    .limit(1);
  // The workspace was visible, so its portal is published and this row exists;
  // a missing one would mean the two policies disagree. Refuse rather than
  // invent defaults, which would publish a portal nobody configured.
  if (!row) return null;

  const publishedProducts = await db
    .select({ productId: ideaPortalProducts.productId })
    .from(ideaPortalProducts)
    .where(eq(ideaPortalProducts.workspaceId, workspace.id));

  const settings: IdeaSettings = {
    portalEnabled: row.portalEnabled,
    portalTitle: row.portalTitle,
    portalProductIds: publishedProducts.map((p) => p.productId),
    portalIdeaStatuses: row.portalIdeaStatuses,
    portalRoadmapEnabled: row.portalRoadmapEnabled,
    portalRoadmapItemStatuses: row.portalRoadmapItemStatuses,
    portalModeration: isPortalModeration(row.portalModeration)
      ? row.portalModeration
      : "review_first",
  };

  return {
    workspaceId: workspace.id,
    orgSlug: slug,
    title: settings.portalTitle?.trim() || workspace.name,
    settings,
  };
}

/**
 * Whether a published portal has anything to show on its ideas view.
 *
 * Every list defaults to empty, so a portal can be switched on and publish
 * nothing at all. That is a legitimate state rather than an error (the settings
 * screen says so too), and it is the difference between a portal that is broken
 * and one whose owner has not finished configuring it.
 */
export function portalShowsIdeas(settings: IdeaSettings): boolean {
  return (
    settings.portalProductIds.length > 0 &&
    settings.portalIdeaStatuses.length > 0
  );
}
