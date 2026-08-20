import {
  and,
  apiKeys,
  count,
  eq,
  isNull,
  members,
  productMembers,
  type Database,
} from "@specboards/db";

import { isMultiTenant } from "@/lib/tenancy";
import { listWorkspaceMembers, type MemberRole, type WorkspaceMember } from "@/lib/workspace";

/**
 * Org-level member management behind /api/v1/org/members. Route handlers stay
 * thin; the org-admin gate lives in the route (`authorizeOrgAdmin`) and the
 * workspace-scoping is the `workspaceId` threaded from that scope. Membership
 * is auth data, so this talks to the owner `getDb()` connection directly
 * (mirroring `workspace.ts`), not the tenant-scoped feature store.
 */

/** The org roles, in privilege order, for validation and pickers. `owner` is
 * the workspace admin; `member` is the read-only org baseline (product access
 * comes from per-product grants). */
export const MEMBER_ROLES: readonly MemberRole[] = ["owner", "member"];

/** Raised for a member action that can't proceed (unknown member, last owner). */
export class OrgMemberError extends Error {}

export type { WorkspaceMember };

/** List the org's members (with role + deactivation state), ordered by name. */
export function listMembers(db: Database, workspaceId: string): Promise<WorkspaceMember[]> {
  return listWorkspaceMembers(db, workspaceId);
}

/** Validate an untrusted role string against {@link MEMBER_ROLES}. */
export function parseRole(raw: unknown): MemberRole {
  if (!MEMBER_ROLES.includes(raw as MemberRole)) {
    throw new OrgMemberError(`role must be one of: ${MEMBER_ROLES.join(", ")}.`);
  }
  return raw as MemberRole;
}

/** One member row (including a deactivated one, unlike `getMembershipFor`). */
async function getMemberRow(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<typeof members.$inferSelect | null> {
  const rows = await db
    .select()
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** How many *active* owners the workspace has right now. */
async function countActiveOwners(db: Database, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        eq(members.role, "owner"),
        isNull(members.deactivatedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Guard against removing the workspace's only owner. `member` is the target's
 * current row; the guard trips only when it is the last *active* owner and the
 * action (demote / remove / deactivate) would drop it from that set.
 */
async function assertNotLastOwner(
  db: Database,
  member: typeof members.$inferSelect,
  verb: string,
): Promise<void> {
  if (member.role !== "owner" || member.deactivatedAt !== null) return;
  if ((await countActiveOwners(db, member.workspaceId)) <= 1) {
    throw new OrgMemberError(`You can't ${verb} the only owner. Make someone else an owner first.`);
  }
}

/** Change a member's org role. Refuses to demote the last owner. */
export async function setMemberRole(
  db: Database,
  workspaceId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  const member = await getMemberRow(db, workspaceId, userId);
  if (!member) throw new OrgMemberError("That person is not a member of this organization.");
  if (member.role === role) return;
  if (role !== "owner") await assertNotLastOwner(db, member, "demote");
  await db
    .update(members)
    .set({ role })
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
}

/**
 * Revoke every live API key a user holds.
 *
 * ── Why this is single-tenant only ─────────────────────────────────────────
 * `api_keys` is keyed on the USER, not on a workspace: a key resolves its
 * workspace through membership at request time. So on a multi-tenant
 * deployment, removing someone from org A already ends that key's access to A,
 * and revoking the key outright would also cut off org B, where they are still
 * a member and the key is legitimately theirs. Precision matters more than
 * reflex here.
 *
 * On single-tenant there is one workspace, so "their keys" and "their keys for
 * this workspace" are the same set, and revoking is exact.
 *
 * Defence in depth rather than the load-bearing fix: `resolveApiMembership`
 * already excludes deactivated members, so a deactivated person's key resolves
 * to no workspace and is refused. This makes the revocation explicit, and means
 * a later reactivation does not silently bring old credentials back with it.
 *
 * Idempotent, and scoped to still-live keys so an already-revoked key keeps its
 * original timestamp rather than being restamped.
 */
async function revokeKeysFor(db: Database, userId: string): Promise<void> {
  if (isMultiTenant()) return;
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
}

/**
 * Remove a member from the org, including their per-product grants.
 *
 * ── Why single-tenant deactivates instead of deleting ──────────────────────
 * On a single-tenant deployment `ensureMembership` auto-joins any authenticated
 * user to the one workspace, and `resolveActiveWorkspace` calls it before it
 * compares the URL slug. Deleting the rows therefore revoked nothing: the
 * removed person was re-joined as a `member` on their next page load, or on any
 * API call that omits an org slug, which the CLI and MCP callers routinely do.
 * "Remove" quietly meant "demote to member", and an operator reasonably reads it
 * as revoking access.
 *
 * Deactivating uses the path that already works rather than inventing a second
 * one: `getMembership` excludes deactivated rows, and the auto-join insert is
 * `onConflictDoNothing`, so the row that is already there stays deactivated
 * instead of being resurrected. A tombstone column would have been the other
 * option and would mean a migration plus a second concept meaning the same
 * thing.
 *
 * Multi-tenant is unaffected and still deletes: it never auto-joins, so the
 * delete is a real removal there, and leaving a deactivated row would keep the
 * person visible in an org they are no longer in.
 */
export async function removeMember(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const member = await getMemberRow(db, workspaceId, userId);
  if (!member) return;
  await assertNotLastOwner(db, member, "remove");

  // Before the membership change, so a failure part-way through leaves the
  // credentials revoked rather than live against a membership that is gone.
  await revokeKeysFor(db, userId);

  await db
    .delete(productMembers)
    .where(and(eq(productMembers.workspaceId, workspaceId), eq(productMembers.userId, userId)));

  if (!isMultiTenant()) {
    await db
      .update(members)
      .set({ deactivatedAt: new Date() })
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
    return;
  }

  await db
    .delete(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
}

/**
 * Suspend or restore a member. Deactivating the last active owner is refused;
 * reactivating clears `deactivatedAt`.
 */
export async function setMemberActive(
  db: Database,
  workspaceId: string,
  userId: string,
  active: boolean,
): Promise<void> {
  const member = await getMemberRow(db, workspaceId, userId);
  if (!member) throw new OrgMemberError("That person is not a member of this organization.");
  if (!active) await assertNotLastOwner(db, member, "deactivate");
  // Same reasoning as removal: a suspended member whose API keys still work has
  // not been suspended. Reactivating does not un-revoke them, deliberately, so
  // a key that was live during a suspension is never live again afterwards.
  if (!active) await revokeKeysFor(db, userId);
  await db
    .update(members)
    .set({ deactivatedAt: active ? null : new Date() })
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
}
