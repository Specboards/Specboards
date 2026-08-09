import {
  and,
  eq,
  isNull,
  mcpWorkspaceBindings,
  members,
  oauthApplications,
  workspaces,
  type Database,
} from "@specboards/db";

/**
 * The workspace an MCP OAuth connection targets, chosen once on the consent
 * screen and keyed by (userId, clientId). Reading and writing both go through
 * the owner connection (`getDb()`), like the rest of the OAuth tables, since
 * they run during auth resolution before any tenant scope exists.
 */

/**
 * Persist the workspace a user picked for an OAuth client at consent time.
 * Upserts on (userId, clientId) so re-consenting (or picking a different
 * workspace) overwrites the previous choice rather than stacking rows.
 */
export async function recordMcpWorkspaceBinding(
  db: Database,
  binding: { userId: string; clientId: string; workspaceId: string },
): Promise<void> {
  await db
    .insert(mcpWorkspaceBindings)
    .values(binding)
    .onConflictDoUpdate({
      target: [mcpWorkspaceBindings.userId, mcpWorkspaceBindings.clientId],
      set: { workspaceId: binding.workspaceId, updatedAt: new Date() },
    });
}

/**
 * The slug of the workspace bound to (userId, clientId), or null when the user
 * never picked one. Returned as a slug so the caller can feed it straight into
 * {@link resolveApiMembership}, which re-validates membership on every request:
 * a binding to a workspace the user has since left simply fails to resolve.
 */
export async function boundWorkspaceSlug(
  db: Database,
  userId: string,
  clientId: string,
): Promise<string | null> {
  const rows = await db
    .select({ slug: workspaces.slug })
    .from(mcpWorkspaceBindings)
    .innerJoin(workspaces, eq(workspaces.id, mcpWorkspaceBindings.workspaceId))
    .where(
      and(
        eq(mcpWorkspaceBindings.userId, userId),
        eq(mcpWorkspaceBindings.clientId, clientId),
      ),
    )
    .limit(1);
  return rows[0]?.slug ?? null;
}

/**
 * The display name an MCP client registered under ("Claude Code", "claude.ai"),
 * or null when the client omitted `client_name` at registration (it is optional
 * in RFC 7591) or the row has since gone.
 *
 * Used to attribute changes in the ledger, so it is read on the write path and
 * kept to one indexed lookup on `client_id`. A null here is not an error: it
 * degrades to "An MCP agent", which still tells a reader nobody typed the change.
 */
export async function oauthClientName(
  db: Database,
  clientId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: oauthApplications.name })
    .from(oauthApplications)
    .where(eq(oauthApplications.clientId, clientId))
    .limit(1);
  return rows[0]?.name?.trim() || null;
}

/** A workspace the user can act in, for the consent-screen picker. */
export interface ConsentWorkspaceOption {
  id: string;
  name: string;
  slug: string;
}

/**
 * The workspaces a user may authorize an MCP connection for: their active
 * (non-deactivated) memberships. An empty list means the account belongs to no
 * workspace, which the consent screen turns into a "switch account" prompt
 * instead of a dead authorization.
 */
export async function consentWorkspaceOptions(
  db: Database,
  userId: string,
): Promise<ConsentWorkspaceOption[]> {
  return db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(and(eq(members.userId, userId), isNull(members.deactivatedAt)))
    .orderBy(workspaces.name);
}
