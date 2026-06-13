import { asc, eq, members, users, workspaces, type Database } from "@specboard/db";

export type Workspace = typeof workspaces.$inferSelect;
export type Member = typeof members.$inferSelect;
export type MemberRole = Member["role"];

/** A workspace member with their display identity, for assignment UIs. */
export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
}

/** List a workspace's members joined to their user records, ordered by name. */
export async function listWorkspaceMembers(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  return db
    .select({
      userId: members.userId,
      name: users.name,
      email: users.email,
      role: members.role,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.workspaceId, workspaceId))
    .orderBy(asc(users.name));
}

/** Roles allowed to mutate workspace data. `viewer` (the default for everyone
 * past the first user) is read-only. */
const WRITE_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>([
  "admin",
  "pm",
  "ux",
  "eng",
]);

export function canWrite(role: MemberRole): boolean {
  return WRITE_ROLES.has(role);
}

/**
 * Workspace + membership bootstrap. The hosted product runs one workspace per
 * Fly app (the "organization"), so "the active workspace" is simply the first
 * one created. The first user to sign up names it and becomes `admin` (see
 * `createWorkspaceWithOwner`); everyone after is auto-joined as a `viewer`
 * ("basic user") by `ensureMembership` on their first authenticated request.
 */

/** The single workspace for this deployment, or null before setup. */
export async function getActiveWorkspace(db: Database): Promise<Workspace | null> {
  const rows = await db
    .select()
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMembership(
  db: Database,
  userId: string,
): Promise<Member | null> {
  const rows = await db
    .select()
    .from(members)
    .where(eq(members.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ensure `userId` belongs to the active workspace. Idempotent: returns the
 * existing membership if any, otherwise joins them as a `viewer`. Returns
 * `null` when no workspace exists yet — the caller routes the user to /setup.
 */
export async function ensureMembership(
  db: Database,
  userId: string,
): Promise<Member | null> {
  const existing = await getMembership(db, userId);
  if (existing) return existing;

  const workspace = await getActiveWorkspace(db);
  if (!workspace) return null;

  await db
    .insert(members)
    .values({ workspaceId: workspace.id, userId, role: "viewer" })
    .onConflictDoNothing({ target: [members.workspaceId, members.userId] });

  // Re-read so a row inserted here or by a concurrent request is returned.
  return getMembership(db, userId);
}

const SLUG_MAX = 48;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
  return slug || "workspace";
}

/**
 * First-user path: create the workspace and make `userId` its `admin`. If a
 * workspace already exists (e.g. a concurrent setup submit), no second org is
 * created — the user is joined to the existing one instead.
 */
export async function createWorkspaceWithOwner(
  db: Database,
  name: string,
  userId: string,
): Promise<Workspace> {
  const existing = await getActiveWorkspace(db);
  if (existing) {
    await ensureMembership(db, userId);
    return existing;
  }

  const [workspace] = await db
    .insert(workspaces)
    .values({ name, slug: slugify(name) })
    .returning();
  if (!workspace) throw new Error("Failed to create workspace.");

  await db
    .insert(members)
    .values({ workspaceId: workspace.id, userId, role: "admin" })
    .onConflictDoNothing({ target: [members.workspaceId, members.userId] });

  return workspace;
}
