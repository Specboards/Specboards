import {
  and,
  count,
  eq,
  isNull,
  members,
  productMembers,
  type Database,
} from "@specboard/db";

import { listWorkspaceMembers, type MemberRole, type WorkspaceMember } from "@/lib/workspace";

/**
 * Org-level member management behind /api/v1/org/members. Route handlers stay
 * thin; the org-admin gate lives in the route (`authorizeOrgAdmin`) and the
 * workspace-scoping is the `workspaceId` threaded from that scope. Membership
 * is auth data, so this talks to the owner `getDb()` connection directly
 * (mirroring `workspace.ts`), not the tenant-scoped feature store.
 */

/** The org roles, in privilege order, for validation and pickers. */
export const MEMBER_ROLES: readonly MemberRole[] = ["admin", "pm", "ux", "eng", "viewer"];

/** Raised for a member action that can't proceed (unknown member, last admin). */
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

/** How many *active* admins the workspace has right now. */
async function countActiveAdmins(db: Database, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        eq(members.role, "admin"),
        isNull(members.deactivatedAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Guard against removing the workspace's only admin. `member` is the target's
 * current row; the guard trips only when it is the last *active* admin and the
 * action (demote / remove / deactivate) would drop it from that set.
 */
async function assertNotLastAdmin(
  db: Database,
  member: typeof members.$inferSelect,
  verb: string,
): Promise<void> {
  if (member.role !== "admin" || member.deactivatedAt !== null) return;
  if ((await countActiveAdmins(db, member.workspaceId)) <= 1) {
    throw new OrgMemberError(`You can't ${verb} the only admin. Promote someone else first.`);
  }
}

/** Change a member's org role. Refuses to demote the last admin. */
export async function setMemberRole(
  db: Database,
  workspaceId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  const member = await getMemberRow(db, workspaceId, userId);
  if (!member) throw new OrgMemberError("That person is not a member of this organization.");
  if (member.role === role) return;
  if (role !== "admin") await assertNotLastAdmin(db, member, "demote");
  await db
    .update(members)
    .set({ role })
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
}

/** Remove a member from the org, including their per-product grants. */
export async function removeMember(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const member = await getMemberRow(db, workspaceId, userId);
  if (!member) return;
  await assertNotLastAdmin(db, member, "remove");
  await db
    .delete(productMembers)
    .where(and(eq(productMembers.workspaceId, workspaceId), eq(productMembers.userId, userId)));
  await db
    .delete(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
}

/**
 * Suspend or restore a member. Deactivating the last active admin is refused;
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
  if (!active) await assertNotLastAdmin(db, member, "deactivate");
  await db
    .update(members)
    .set({ deactivatedAt: active ? null : new Date() })
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
}
