import {
  and,
  eq,
  isNull,
  mcpWorkspaceBindings,
  members,
  oauthAccessTokens,
  oauthApplications,
  oauthConsents,
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
 * Persist the workspace a user picked for an OAuth client at consent time,
 * along with what the client was granted. Upserts on (userId, clientId) so
 * re-consenting (or picking a different workspace) overwrites the previous
 * choice rather than stacking rows.
 *
 * `grant` is optional only so a caller that has not been updated cannot
 * silently write a NULL grant over a real one: when it is omitted the existing
 * scopes are left alone rather than cleared.
 */
export async function recordMcpWorkspaceBinding(
  db: Database,
  binding: {
    userId: string;
    clientId: string;
    workspaceId: string;
    grant?: { scopes: string[]; allowDestructive: boolean };
  },
): Promise<void> {
  const { grant, ...row } = binding;
  await db
    .insert(mcpWorkspaceBindings)
    .values({
      ...row,
      scopes: grant?.scopes ?? null,
      allowDestructive: grant?.allowDestructive ?? false,
    })
    .onConflictDoUpdate({
      target: [mcpWorkspaceBindings.userId, mcpWorkspaceBindings.clientId],
      set: {
        workspaceId: binding.workspaceId,
        updatedAt: new Date(),
        ...(grant
          ? { scopes: grant.scopes, allowDestructive: grant.allowDestructive }
          : {}),
      },
    });
}

/** What an OAuth connection resolved to: where it acts and what it may do. */
export interface McpConnectionBinding {
  /**
   * Workspace slug, so the caller can feed it straight into
   * `resolveApiMembership`, which re-validates membership on every request: a
   * binding to a workspace the user has since left simply fails to resolve.
   */
  slug: string;
  /**
   * The granted scopes, or `null` when this connection predates consent asking.
   * `null` must be passed through as `[]` to the scope checker (unrestricted),
   * which is how live agents keep working; see `resolveMcpAuth`.
   */
  scopes: string[] | null;
  allowDestructive: boolean;
}

/**
 * The binding for (userId, clientId), or null when the user never consented
 * through a screen that recorded one.
 */
export async function boundConnection(
  db: Database,
  userId: string,
  clientId: string,
): Promise<McpConnectionBinding | null> {
  const rows = await db
    .select({
      slug: workspaces.slug,
      scopes: mcpWorkspaceBindings.scopes,
      allowDestructive: mcpWorkspaceBindings.allowDestructive,
    })
    .from(mcpWorkspaceBindings)
    .innerJoin(workspaces, eq(workspaces.id, mcpWorkspaceBindings.workspaceId))
    .where(
      and(
        eq(mcpWorkspaceBindings.userId, userId),
        eq(mcpWorkspaceBindings.clientId, clientId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record that this connection just authenticated a call, so the settings list
 * can show a stale connection as stale.
 *
 * One indexed update on the unique key, on the same path where `verifyApiKey`
 * already bumps `api_keys.last_used_at` for every REST call, so this is the
 * established cost rather than a new one.
 */
export async function touchMcpConnection(
  db: Database,
  userId: string,
  clientId: string,
): Promise<void> {
  await db
    .update(mcpWorkspaceBindings)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(mcpWorkspaceBindings.userId, userId),
        eq(mcpWorkspaceBindings.clientId, clientId),
      ),
    );
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

/** One OAuth connection, for the "Connected agents" list in settings. */
export interface McpConnectionView {
  clientId: string;
  /** The name the client registered under, or null (optional in RFC 7591). */
  clientName: string | null;
  workspaceName: string;
  scopes: string[] | null;
  allowDestructive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Every MCP connection this user has authorized, newest first. Scoped to the
 * user, not the workspace: an OAuth connection acts as a person, so it is that
 * person's to review and revoke, not their owner's.
 */
export async function listMcpConnections(
  db: Database,
  userId: string,
): Promise<McpConnectionView[]> {
  const rows = await db
    .select({
      clientId: mcpWorkspaceBindings.clientId,
      clientName: oauthApplications.name,
      workspaceName: workspaces.name,
      scopes: mcpWorkspaceBindings.scopes,
      allowDestructive: mcpWorkspaceBindings.allowDestructive,
      lastUsedAt: mcpWorkspaceBindings.lastUsedAt,
      createdAt: mcpWorkspaceBindings.createdAt,
    })
    .from(mcpWorkspaceBindings)
    .innerJoin(workspaces, eq(workspaces.id, mcpWorkspaceBindings.workspaceId))
    .leftJoin(
      oauthApplications,
      eq(oauthApplications.clientId, mcpWorkspaceBindings.clientId),
    )
    .where(eq(mcpWorkspaceBindings.userId, userId));
  return rows
    .map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName?.trim() || null,
      workspaceName: r.workspaceName,
      scopes: r.scopes,
      allowDestructive: r.allowDestructive,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Revoke one connection: delete its access tokens, its recorded consent, and
 * the binding itself. The agent stops on its next call and, because the consent
 * row is gone too, reconnecting prompts the user again rather than silently
 * reusing the old answer.
 */
export async function revokeMcpConnection(
  db: Database,
  userId: string,
  clientId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(mcpWorkspaceBindings)
    .where(
      and(
        eq(mcpWorkspaceBindings.userId, userId),
        eq(mcpWorkspaceBindings.clientId, clientId),
      ),
    )
    .returning({ clientId: mcpWorkspaceBindings.clientId });
  await db
    .delete(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.userId, userId),
        eq(oauthAccessTokens.clientId, clientId),
      ),
    );
  await db
    .delete(oauthConsents)
    .where(
      and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId)),
    );
  return deleted.length > 0;
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
