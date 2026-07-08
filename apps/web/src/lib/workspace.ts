import {
  and,
  asc,
  eq,
  isNull,
  members,
  products,
  users,
  workspaceLevels,
  workspaces,
  type Database,
} from "@specboard/db";
import { DEFAULT_LEVELS, DEFAULT_PRODUCT_KEY } from "@specboard/core";

import {
  isReservedOrgSlug,
  LOCAL_ORG_SLUG,
  ORG_SLUG_MAX,
  slugifyOrg,
} from "@/lib/org-path";
import { isMultiTenant } from "@/lib/tenancy";

export type Workspace = typeof workspaces.$inferSelect;
export type Member = typeof members.$inferSelect;
export type MemberRole = Member["role"];

/** A workspace member with their display identity, for assignment UIs. */
export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  /** Non-null when the membership is suspended (see `members.deactivatedAt`). */
  deactivatedAt: Date | null;
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
      deactivatedAt: members.deactivatedAt,
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

/** Fetch a single workspace by id, or null if it doesn't exist. */
export async function getWorkspaceById(
  db: Database,
  workspaceId: string,
): Promise<Workspace | null> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

/** Rename a workspace ("company"). Returns the updated row, or null if gone. */
export async function updateWorkspace(
  db: Database,
  workspaceId: string,
  patch: { name: string },
): Promise<Workspace | null> {
  const rows = await db
    .update(workspaces)
    .set({ name: patch.name })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Ensure the workspace has its default product (the one every spec/item falls
 * into until moved). Idempotent; returns the product id. Used on workspace
 * bootstrap and by the spec sync so synced specs always belong to a product.
 */
export async function ensureDefaultProduct(
  db: Database,
  workspaceId: string,
): Promise<string> {
  const existing = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(eq(products.workspaceId, workspaceId), eq(products.key, DEFAULT_PRODUCT_KEY)),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const workspace = await getWorkspaceById(db, workspaceId);
  const [created] = await db
    .insert(products)
    .values({
      workspaceId,
      key: DEFAULT_PRODUCT_KEY,
      name: workspace?.name ?? "General",
      position: 0,
    })
    .onConflictDoNothing({ target: [products.workspaceId, products.key] })
    .returning({ id: products.id });
  if (created) return created.id;

  // Lost an insert race — re-read.
  const row = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(eq(products.workspaceId, workspaceId), eq(products.key, DEFAULT_PRODUCT_KEY)),
    )
    .limit(1);
  if (!row[0]) throw new Error("Failed to ensure the default product.");
  return row[0].id;
}

export async function getMembership(
  db: Database,
  userId: string,
): Promise<Member | null> {
  // Deterministic pick when a user belongs to more than one workspace (oldest
  // membership) so API/CLI scope is stable rather than DB-order-dependent. The
  // proper multi-org fix is to honor an org selector on the API surface too;
  // until then this at least removes the nondeterminism.
  const rows = await db
    .select()
    .from(members)
    .where(and(eq(members.userId, userId), isNull(members.deactivatedAt)))
    .orderBy(members.createdAt)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Every workspace `userId` belongs to. The basis for the org switcher and for
 * multi-org membership; single-tenant deployments simply return ≤1 row.
 */
export async function listMembershipsForUser(
  db: Database,
  userId: string,
): Promise<Member[]> {
  return db.select().from(members).where(eq(members.userId, userId));
}

/** The caller's membership in one specific workspace, or null when not a member. */
export async function getMembershipFor(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<Member | null> {
  const rows = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.userId, userId),
        eq(members.workspaceId, workspaceId),
        isNull(members.deactivatedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** A workspace's URL slug by id, falling back to the local slug when missing. */
export async function workspaceSlug(
  db: Database,
  workspaceId: string,
): Promise<string> {
  const workspace = await getWorkspaceById(db, workspaceId);
  return workspace?.slug ?? LOCAL_ORG_SLUG;
}

/** Look up a workspace by its URL slug, or null when no such org exists. */
export async function getWorkspaceBySlug(
  db: Database,
  slug: string,
): Promise<Workspace | null> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Ensure `userId` belongs to the single active workspace, auto-joining them as
 * a `viewer`. This is the **single-tenant** convenience: when a deployment
 * serves one org, every authenticated user belongs to it. Idempotent; returns
 * `null` when no workspace exists yet — the caller routes the user to /setup.
 *
 * Auto-join is intentionally NOT offered for a specific workspace: in
 * multi-tenant mode, joining an org is explicit (invite), so callers there go
 * through {@link resolveActiveWorkspace}, which only returns an *existing*
 * membership.
 */
export async function ensureMembership(
  db: Database,
  userId: string,
): Promise<Member | null> {
  const existing = await getMembership(db, userId);
  if (existing) return existing;

  // Multi-tenant: joining an org is explicit (create your own via /setup, or be
  // invited) — never silently drop a new user into another tenant's workspace.
  if (isMultiTenant()) return null;

  const workspace = await getActiveWorkspace(db);
  if (!workspace) return null;

  await db
    .insert(members)
    .values({ workspaceId: workspace.id, userId, role: "viewer" })
    .onConflictDoNothing({ target: [members.workspaceId, members.userId] });

  // Re-read so a row inserted here or by a concurrent request is returned.
  return getMembership(db, userId);
}

/**
 * Resolve the caller's **active workspace membership** — the single seam that
 * replaces the old "first workspace" assumption (ADR 0001, D2).
 *
 * - **Multi-tenant + an `orgSlug`** (from the URL path, ADR 0001 D3): the org
 *   is looked up by slug and membership is *required* — no auto-join. Returns
 *   `null` when the org is unknown or the caller isn't a member, so the caller
 *   can 404/redirect. This is the IDOR-safe path: the URL is only a hint, and
 *   authority comes from a validated membership.
 * - **Multi-tenant, no slug** (the bare `/` root): resolve the caller's own
 *   membership without auto-join — none means "send them to /setup".
 * - **Single-tenant (or no slug yet)**: the one workspace, auto-joined as
 *   viewer via {@link ensureMembership} — byte-for-byte the current behavior.
 */
export async function resolveActiveWorkspace(
  db: Database,
  userId: string,
  opts: { orgSlug?: string | null } = {},
): Promise<Member | null> {
  if (isMultiTenant()) {
    if (opts.orgSlug) {
      const workspace = await getWorkspaceBySlug(db, opts.orgSlug);
      if (!workspace) return null;
      return getMembershipFor(db, userId, workspace.id);
    }
    // Root with no org in the URL: the caller's existing membership, if any.
    // (Multi-org switching is a later concern; today a user has one org.)
    return getMembership(db, userId);
  }
  // Single-tenant: the one workspace, auto-joined. If the URL carries a slug it
  // must match — otherwise the URL is lying about which org you're in.
  const membership = await ensureMembership(db, userId);
  if (membership && opts.orgSlug) {
    const workspace = await getActiveWorkspace(db);
    if (workspace && workspace.slug !== opts.orgSlug) return null;
  }
  return membership;
}

/** Postgres unique-violation SQLSTATE — a slug lost an insert race. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/** Why a chosen org slug can't be used, so the setup form can react precisely. */
export type WorkspaceSlugErrorCode = "slug_taken" | "slug_invalid";

/**
 * A requested org slug is unavailable (already taken, reserved, or empty).
 * Carries a free `suggestion` (when one exists) so the UI can offer it.
 */
export class WorkspaceSlugError extends Error {
  constructor(
    readonly code: WorkspaceSlugErrorCode,
    message: string,
    readonly suggestion?: string,
  ) {
    super(message);
    this.name = "WorkspaceSlugError";
  }
}

/** True when `slug` is free to use (not reserved and not already a workspace). */
async function isSlugAvailable(db: Database, slug: string): Promise<boolean> {
  if (isReservedOrgSlug(slug)) return false;
  return (await getWorkspaceBySlug(db, slug)) === null;
}

/** First free `${base}-N` (N≥2), or null if none found in a sane range. */
async function suggestFreeSlug(db: Database, base: string): Promise<string | undefined> {
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base}-${n}`.slice(0, ORG_SLUG_MAX).replace(/-+$/g, "");
    if (await isSlugAvailable(db, candidate)) return candidate;
  }
  return undefined;
}

/** Insert the workspace + owner membership + default levels/product. */
async function provisionWorkspace(
  db: Database,
  name: string,
  slug: string,
  userId: string,
): Promise<Workspace> {
  const [workspace] = await db.insert(workspaces).values({ name, slug }).returning();
  if (!workspace) throw new Error("Failed to create workspace.");

  await db
    .insert(members)
    .values({ workspaceId: workspace.id, userId, role: "admin" })
    .onConflictDoNothing({ target: [members.workspaceId, members.userId] });

  // Seed the default work-tracking hierarchy (Initiative → Epic → Feature).
  await db
    .insert(workspaceLevels)
    .values(
      DEFAULT_LEVELS.map((l) => ({
        workspaceId: workspace.id,
        key: l.key,
        label: l.label,
        position: l.position,
        isLeaf: l.isLeaf,
      })),
    )
    .onConflictDoNothing({
      target: [workspaceLevels.workspaceId, workspaceLevels.key],
    });

  // Seed the default product (every spec/item lands here until moved).
  await ensureDefaultProduct(db, workspace.id);

  return workspace;
}

/**
 * Create an organization and make `userId` its `admin`.
 *
 * - **Multi-tenant:** always creates a *new* org. The slug is derived from
 *   `name` (or an explicit `opts.slug`); if it's empty, reserved, or already
 *   taken we throw {@link WorkspaceSlugError} (with a free suggestion) rather
 *   than silently appending a suffix, so the user can choose a different name.
 * - **Single-tenant:** the N=1 path — if a workspace already exists (e.g. a
 *   concurrent setup submit) no second org is created; the caller is joined to
 *   the existing one instead. Byte-for-byte the historical behavior.
 */
export async function createWorkspaceWithOwner(
  db: Database,
  name: string,
  userId: string,
  opts: { slug?: string } = {},
): Promise<Workspace> {
  if (!isMultiTenant()) {
    const existing = await getActiveWorkspace(db);
    if (existing) {
      await ensureMembership(db, userId);
      return existing;
    }
    return provisionWorkspace(db, name, slugifyOrg(name) || "workspace", userId);
  }

  const slug = slugifyOrg(opts.slug ?? name);
  if (!slug) {
    throw new WorkspaceSlugError(
      "slug_invalid",
      "That name has no usable letters or numbers for a URL. Try another.",
    );
  }
  if (isReservedOrgSlug(slug)) {
    throw new WorkspaceSlugError(
      "slug_invalid",
      `"${slug}" is reserved. Pick a different name.`,
      await suggestFreeSlug(db, slug),
    );
  }
  if (!(await isSlugAvailable(db, slug))) {
    throw new WorkspaceSlugError(
      "slug_taken",
      `The URL "${slug}" is already taken. Pick a different name.`,
      await suggestFreeSlug(db, slug),
    );
  }

  try {
    return await provisionWorkspace(db, name, slug, userId);
  } catch (err) {
    // Lost the race to a concurrent create with the same slug.
    if (isUniqueViolation(err)) {
      throw new WorkspaceSlugError(
        "slug_taken",
        `The URL "${slug}" was just taken. Pick a different name.`,
        await suggestFreeSlug(db, slug),
      );
    }
    throw err;
  }
}
