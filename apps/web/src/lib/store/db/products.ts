/**
 * Products, product groups, members, and the roll-up summaries over them.
 *
 * The domain the rest of the store asks questions of. Five of the seven
 * `DbStoreContext` members are implemented here, because they are all the same
 * question in different words: who is acting (`accessIn`), what may they reach
 * (`productVisibilityIn`), is this product real (`requireProductId`), where
 * does work go when nobody said (`defaultProductId`), and is this person one of
 * us (`assertWorkspaceMember`). `DbStore` delegates them like any other method,
 * so a domain module calling `ctx.accessIn` reaches this code.
 *
 * Two things here are easy to get wrong and are worth stating before changing
 * anything.
 *
 * A group's roll-up covers its whole subtree, not its direct children, which is
 * why `descendantGroupIds` appears rather than a parent-id filter. And every
 * roll-up is computed over the products the caller can actually read, so two
 * people looking at the same group can legitimately see different totals. That
 * is the intended behaviour: the alternative leaks the size of work in private
 * products through arithmetic.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import {
  canReadProduct,
  DEFAULT_PRODUCT_KEY,
  descendantGroupIds,
  groupKeyFromName,
  productKeyFromName,
  wouldCreateCycle,
  wouldExceedDepth,
} from "@specboards/core";

import {
  and,
  asc,
  count,
  eq,
  featureLinks,
  features,
  inArray,
  lt,
  members,
  ne,
  productGroups,
  productMembers,
  releases,
  products,
  sql,
  users,
} from "@specboards/db";

import {
  FeatureError,
  GroupError,
  ProductError,
  type BlockingEdge,
  type GroupSummary,
  type ProductAccess,
  type CreateProductGroupInput,
  type CreateProductInput,
  type ProductGroupPatch,
  type ProductGroupRecord,
  SIGNAL_SAMPLE_LIMIT,
  type GroupProductSummary,
  type ProductMemberInput,
  type ProductMemberRecord,
  type ProductPatch,
  type ProductRecord,
  type SignalItem,
  type WorkspaceScope,
  type WorkspaceSummary,
  type WorkspaceSignals,
  type WorkspaceSummaryOptions,
} from "../types";

import {
  canReadProductId,
  doneStatusesIn,
  type DbStoreContext,
  type ProductVisibilityRow,
  type Tx,
} from "./context";
export async function getProductAccess(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<ProductAccess> {
  return ctx.scoped(scope, (tx) => accessIn(ctx, tx, scope!));
}

export async function listProducts(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<ProductRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [rows, counts, access] = await Promise.all([
      tx
        .select()
        .from(products)
        .where(eq(products.workspaceId, ws))
        .orderBy(asc(products.position), asc(products.name)),
      itemCounts(ctx, tx, ws),
      accessIn(ctx, tx, scope!),
    ]);
    return rows
      .filter((p) => canReadProduct(access, p))
      .map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        description: p.description,
        visibility: p.visibility,
        position: p.position,
        color: p.color,
        groupId: p.groupId,
        itemCount: counts.get(p.id) ?? 0,
        viewerRole: access.roles.get(p.id) ?? null,
      }));
  });
}

export async function getProduct(
  ctx: DbStoreContext,
  key: string,
  scope?: WorkspaceScope,
): Promise<ProductRecord | null> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const row = await tx.query.products.findFirst({
      where: and(eq(products.workspaceId, ws), eq(products.key, key)),
    });
    if (!row) return null;
    const access = await accessIn(ctx, tx, scope!);
    if (!canReadProduct(access, row)) return null;
    const counts = await itemCounts(ctx, tx, ws);
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      position: row.position,
      color: row.color,
      groupId: row.groupId,
      itemCount: counts.get(row.id) ?? 0,
      viewerRole: access.roles.get(row.id) ?? null,
    };
  });
}

export async function createProduct(
  ctx: DbStoreContext,
  input: CreateProductInput,
  scope?: WorkspaceScope,
): Promise<ProductRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const name = input.name.trim();
    if (!name) throw new ProductError("Product name is required.");
    const taken = new Set(
      (
        await tx
          .select({ key: products.key })
          .from(products)
          .where(eq(products.workspaceId, ws))
      ).map((r) => r.key),
    );
    const key = productKeyFromName(name, taken);
    const max = await tx
      .select({ m: sql<number>`coalesce(max(${products.position}), -1)` })
      .from(products)
      .where(eq(products.workspaceId, ws));
    const [row] = await tx
      .insert(products)
      .values({
        workspaceId: ws,
        key,
        name,
        description: input.description ?? null,
        visibility: input.visibility ?? "org",
        color: input.color ?? null,
        position: Number(max[0]?.m ?? -1) + 1,
      })
      .returning();
    if (!row) throw new ProductError("Failed to create product.");
    // Make the creator an explicit admin of the product they just created.
    // Org admins already have full access via RLS, but recording membership
    // keeps them in the product's member list and preserves their standing
    // if they are later demoted from org admin.
    await tx
      .insert(productMembers)
      .values({
        workspaceId: ws,
        productId: row.id,
        userId: scope!.userId,
        role: "admin",
      })
      .onConflictDoUpdate({
        target: [productMembers.productId, productMembers.userId],
        set: { role: "admin" },
      });
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      position: row.position,
      color: row.color,
      groupId: row.groupId,
      itemCount: 0,
      viewerRole: "admin",
    };
  });
}

export async function updateProduct(
  ctx: DbStoreContext,
  id: string,
  patch: ProductPatch,
  scope?: WorkspaceScope,
): Promise<ProductRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ProductError("Product name is required.");
      set.name = name;
    }
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.visibility !== undefined) {
      // Changing visibility can expose a private product to the whole org (or
      // hide an org one), so restrict it to org admins even though a product
      // admin may otherwise manage the product's settings.
      const current = await tx
        .select({ visibility: products.visibility })
        .from(products)
        .where(and(eq(products.id, id), eq(products.workspaceId, ws)))
        .limit(1);
      if (
        current[0] &&
        current[0].visibility !== patch.visibility &&
        !(await accessIn(ctx, tx, scope!)).isOrgAdmin
      ) {
        throw new ProductError(
          "Only the workspace owner can change a product's visibility.",
        );
      }
      set.visibility = patch.visibility;
    }
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.groupId !== undefined) {
      if (patch.groupId !== null) {
        await requireGroupId(ctx, tx, ws, patch.groupId);
      }
      set.groupId = patch.groupId;
    }
    const [row] = await tx
      .update(products)
      .set(set)
      .where(and(eq(products.id, id), eq(products.workspaceId, ws)))
      .returning();
    if (!row) throw new ProductError(`Unknown product: ${id}`);
    const counts = await itemCounts(ctx, tx, ws);
    const access = await accessIn(ctx, tx, scope!);
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      position: row.position,
      color: row.color,
      groupId: row.groupId,
      itemCount: counts.get(row.id) ?? 0,
      viewerRole: access.roles.get(row.id) ?? null,
    };
  });
}

export async function deleteProduct(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const used = await tx
      .select({ n: count() })
      .from(features)
      .where(and(eq(features.workspaceId, ws), eq(features.productId, id)));
    if (Number(used[0]?.n ?? 0) > 0) {
      throw new ProductError(
        "Can't delete a product while it still has work items.",
      );
    }
    const deleted = await tx
      .delete(products)
      .where(and(eq(products.id, id), eq(products.workspaceId, ws)))
      .returning({ id: products.id });
    if (!deleted[0]) throw new ProductError(`Unknown product: ${id}`);
  });
}

export async function listProductGroups(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<ProductGroupRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [rows, counts] = await Promise.all([
      tx
        .select()
        .from(productGroups)
        .where(eq(productGroups.workspaceId, ws))
        .orderBy(asc(productGroups.position), asc(productGroups.name)),
      groupProductCounts(ctx, tx, ws),
    ]);
    return rows.map((row) => groupRecord(row, counts));
  });
}

export async function createProductGroup(
  ctx: DbStoreContext,
  input: CreateProductGroupInput,
  scope?: WorkspaceScope,
): Promise<ProductGroupRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const name = input.name.trim();
    if (!name) throw new GroupError("Group name is required.");
    const existing = await tx
      .select({
        id: productGroups.id,
        parentId: productGroups.parentId,
        key: productGroups.key,
        position: productGroups.position,
      })
      .from(productGroups)
      .where(eq(productGroups.workspaceId, ws));
    const parentId = input.parentId ?? null;
    if (parentId) {
      await requireGroupId(ctx, tx, ws, parentId);
      if (wouldExceedDepth(existing, "new-group", parentId)) {
        throw new GroupError("Groups can only be nested a few levels deep.");
      }
    }
    const key = groupKeyFromName(name, new Set(existing.map((g) => g.key)));
    const position = existing.reduce((m, g) => Math.max(m, g.position), -1) + 1;
    const [row] = await tx
      .insert(productGroups)
      .values({
        workspaceId: ws,
        key,
        name,
        description: input.description ?? null,
        color: input.color ?? null,
        parentId,
        position,
      })
      .returning();
    if (!row) throw new GroupError("Failed to create group.");
    return groupRecord(row, new Map());
  });
}

export async function updateProductGroup(
  ctx: DbStoreContext,
  id: string,
  patch: ProductGroupPatch,
  scope?: WorkspaceScope,
): Promise<ProductGroupRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new GroupError("Group name is required.");
      set.name = name;
    }
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.parentId !== undefined) {
      if (patch.parentId !== null) {
        await requireGroupId(ctx, tx, ws, patch.parentId);
        const existing = await tx
          .select({
            id: productGroups.id,
            parentId: productGroups.parentId,
          })
          .from(productGroups)
          .where(eq(productGroups.workspaceId, ws));
        if (wouldCreateCycle(existing, id, patch.parentId)) {
          throw new GroupError(
            "A group can't be nested inside itself or its own subgroups.",
          );
        }
        if (wouldExceedDepth(existing, id, patch.parentId)) {
          throw new GroupError("Groups can only be nested a few levels deep.");
        }
      }
      set.parentId = patch.parentId;
    }
    const [row] = await tx
      .update(productGroups)
      .set(set)
      .where(and(eq(productGroups.id, id), eq(productGroups.workspaceId, ws)))
      .returning();
    if (!row) throw new GroupError(`Unknown product group: ${id}`);
    const counts = await groupProductCounts(ctx, tx, ws);
    return groupRecord(row, counts);
  });
}

export async function deleteProductGroup(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [children, memberProducts] = await Promise.all([
      tx
        .select({ n: count() })
        .from(productGroups)
        .where(
          and(
            eq(productGroups.workspaceId, ws),
            eq(productGroups.parentId, id),
          ),
        ),
      tx
        .select({ n: count() })
        .from(products)
        .where(and(eq(products.workspaceId, ws), eq(products.groupId, id))),
    ]);
    if (Number(children[0]?.n ?? 0) > 0) {
      throw new GroupError(
        "Can't delete a group while it still has subgroups.",
      );
    }
    if (Number(memberProducts[0]?.n ?? 0) > 0) {
      throw new GroupError("Can't delete a group while it still has products.");
    }
    const deleted = await tx
      .delete(productGroups)
      .where(and(eq(productGroups.id, id), eq(productGroups.workspaceId, ws)))
      .returning({ id: productGroups.id });
    if (!deleted[0]) throw new GroupError(`Unknown product group: ${id}`);
  });
}

export async function getGroupSummary(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<GroupSummary> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [groupRows, counts, access] = await Promise.all([
      tx
        .select()
        .from(productGroups)
        .where(eq(productGroups.workspaceId, ws))
        .orderBy(asc(productGroups.position), asc(productGroups.name)),
      groupProductCounts(ctx, tx, ws),
      accessIn(ctx, tx, scope!),
    ]);
    const group = groupRows.find((g) => g.id === id);
    if (!group) throw new GroupError(`Unknown product group: ${id}`);

    // Aggregates only ever cover products the viewer can read; a private
    // product in the subtree simply doesn't contribute (matching listProducts).
    const subtree = descendantGroupIds(groupRows, id);
    const productRows = await tx
      .select()
      .from(products)
      .where(eq(products.workspaceId, ws));
    const readable = productRows.filter(
      (p) => p.groupId && subtree.has(p.groupId) && canReadProduct(access, p),
    );

    const summaries = await productAggregates(
      ctx,
      tx,
      ws,
      readable.map((p) => p.id),
    );

    // Keep product order consistent with listProducts (position, then name).
    const ordered = [...readable]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((p) => summaries.get(p.id)!);

    return {
      group: groupRecord(group, counts),
      subgroups: groupRows
        .filter((g) => g.parentId === id)
        .map((g) => groupRecord(g, counts)),
      products: ordered,
    };
  });
}

export async function listBlockingEdges(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<BlockingEdge[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [rows, access, productById] = await Promise.all([
      tx
        .select({
          id: features.id,
          specId: features.specId,
          productId: features.productId,
        })
        .from(features)
        .where(eq(features.workspaceId, ws)),
      accessIn(ctx, tx, scope!),
      productVisibilityIn(ctx, tx, ws),
    ]);
    // Same filter listFeatures applies to the counts it derives from these
    // edges: an edge is only visible when both of its ends are.
    const specById = new Map(
      rows
        .filter((row) => canReadProductId(access, productById, row.productId))
        .map((row) => [row.id, row.specId]),
    );
    const links = await tx
      .select({
        fromFeatureId: featureLinks.fromFeatureId,
        toFeatureId: featureLinks.toFeatureId,
      })
      .from(featureLinks)
      .where(
        and(eq(featureLinks.workspaceId, ws), eq(featureLinks.type, "blocks")),
      );
    const out: BlockingEdge[] = [];
    for (const link of links) {
      const blocker = specById.get(link.fromFeatureId);
      const blocked = specById.get(link.toFeatureId);
      if (blocker && blocked) {
        out.push({ blockerSpecId: blocker, blockedSpecId: blocked });
      }
    }
    return out;
  });
}

export async function getWorkspaceSummary(
  ctx: DbStoreContext,
  options: WorkspaceSummaryOptions,
  scope?: WorkspaceScope,
): Promise<WorkspaceSummary> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [productRows, access] = await Promise.all([
      tx.select().from(products).where(eq(products.workspaceId, ws)),
      accessIn(ctx, tx, scope!),
    ]);
    // Same visibility rule as listProducts and the group roll-up: a product
    // the viewer cannot read contributes nothing, so no total can betray that
    // it exists.
    const readable = productRows.filter((p) => canReadProduct(access, p));
    const readableIds = readable.map((p) => p.id);

    const summaries = await productAggregates(ctx, tx, ws, readableIds);
    const ordered = [...readable]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((p) => summaries.get(p.id)!);

    return {
      products: ordered,
      signals: await workspaceSignals(ctx, tx, ws, readableIds, options),
    };
  });
}

export async function listProductMembers(
  ctx: DbStoreContext,
  productId: string,
  scope?: WorkspaceScope,
): Promise<ProductMemberRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const rows = await tx
      .select({
        userId: productMembers.userId,
        name: users.name,
        email: users.email,
        role: productMembers.role,
      })
      .from(productMembers)
      .innerJoin(users, eq(users.id, productMembers.userId))
      .where(
        and(
          eq(productMembers.workspaceId, scope!.workspaceId),
          eq(productMembers.productId, productId),
        ),
      )
      .orderBy(asc(users.name));
    return rows;
  });
}

export async function setProductMember(
  ctx: DbStoreContext,
  productId: string,
  input: ProductMemberInput,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    await requireProductId(ctx, tx, ws, productId);
    await assertWorkspaceMember(ctx, tx, ws, input.userId);
    await tx
      .insert(productMembers)
      .values({
        workspaceId: ws,
        productId,
        userId: input.userId,
        role: input.role,
      })
      .onConflictDoUpdate({
        target: [productMembers.productId, productMembers.userId],
        set: { role: input.role },
      });
  });
}

export async function removeProductMember(
  ctx: DbStoreContext,
  productId: string,
  userId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    await tx
      .delete(productMembers)
      .where(
        and(
          eq(productMembers.workspaceId, scope!.workspaceId),
          eq(productMembers.productId, productId),
          eq(productMembers.userId, userId),
        ),
      );
  });
}

/** The workspace's default product id, creating it if it's somehow missing. */
export async function defaultProductId(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
): Promise<string> {
  const existing = await tx
    .select({ id: products.id })
    .from(products)
    .where(
      and(eq(products.workspaceId, ws), eq(products.key, DEFAULT_PRODUCT_KEY)),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await tx
    .insert(products)
    .values({
      workspaceId: ws,
      key: DEFAULT_PRODUCT_KEY,
      name: "General",
      position: 0,
    })
    .onConflictDoNothing({ target: [products.workspaceId, products.key] })
    .returning({ id: products.id });
  if (created) return created.id;
  // Lost an insert race, so re-read.
  const row = await tx
    .select({ id: products.id })
    .from(products)
    .where(
      and(eq(products.workspaceId, ws), eq(products.key, DEFAULT_PRODUCT_KEY)),
    )
    .limit(1);
  if (!row[0]) throw new ProductError("Could not resolve the default product.");
  return row[0].id;
}

/** Verify a product id belongs to the workspace, returning it. */
export async function requireProductId(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  productId: string,
): Promise<string> {
  const row = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.workspaceId, ws)))
    .limit(1);
  if (!row[0]) throw new ProductError(`Unknown product: ${productId}`);
  return row[0].id;
}

/**
 * Assert `userId` is a member of `ws`. Guards fields that reference a user by
 * id (assignee, product-member target) so a caller can't point them at an
 * arbitrary global user id (e.g. someone in another workspace).
 */
export async function assertWorkspaceMember(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  userId: string,
): Promise<void> {
  const row = await tx
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, ws), eq(members.userId, userId)))
    .limit(1);
  if (!row[0]) {
    throw new FeatureError("That user is not a member of this workspace.");
  }
}

/** Build the acting user's product access (org-admin flag + per-product roles). */
export async function accessIn(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
): Promise<ProductAccess> {
  const membership = await tx
    .select({ role: members.role })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, scope.workspaceId),
        eq(members.userId, scope.userId),
      ),
    )
    .limit(1);
  const mine = await tx
    .select({
      productId: productMembers.productId,
      role: productMembers.role,
    })
    .from(productMembers)
    .where(
      and(
        eq(productMembers.workspaceId, scope.workspaceId),
        eq(productMembers.userId, scope.userId),
      ),
    );
  const roles = new Map(mine.map((g) => [g.productId, g.role] as const));
  return { isOrgAdmin: membership[0]?.role === "owner", roles };
}

/** Product visibility by id for owner-connection app-side RLS mirroring. */
export async function productVisibilityIn(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
): Promise<Map<string, ProductVisibilityRow>> {
  const rows = await tx
    .select({ id: products.id, visibility: products.visibility })
    .from(products)
    .where(eq(products.workspaceId, workspaceId));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Item counts per product across the workspace. */
async function itemCounts(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ productId: features.productId, n: count() })
    .from(features)
    .where(eq(features.workspaceId, ws))
    .groupBy(features.productId);
  const out = new Map<string, number>();
  for (const r of rows) if (r.productId) out.set(r.productId, Number(r.n));
  return out;
}

/** Verify a group id belongs to the workspace, returning it. */
async function requireGroupId(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  groupId: string,
): Promise<string> {
  const row = await tx
    .select({ id: productGroups.id })
    .from(productGroups)
    .where(
      and(eq(productGroups.id, groupId), eq(productGroups.workspaceId, ws)),
    )
    .limit(1);
  if (!row[0]) throw new GroupError(`Unknown product group: ${groupId}`);
  return row[0].id;
}

/** Direct-member product counts per group across the workspace. */
async function groupProductCounts(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ groupId: products.groupId, n: count() })
    .from(products)
    .where(eq(products.workspaceId, ws))
    .groupBy(products.groupId);
  const out = new Map<string, number>();
  for (const r of rows) if (r.groupId) out.set(r.groupId, Number(r.n));
  return out;
}

/**
 * Per-product item totals, status breakdown, and per-release progress, all
 * derived at read time from one grouped scan (no denormalized counts).
 *
 * The roll-up shape both dashboards share: the caller decides which products
 * are in scope (a group's subtree, or the whole workspace) and this decides
 * what a count means, so the group and leadership dashboards cannot drift.
 */
async function productAggregates(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  productIds: string[],
): Promise<Map<string, GroupProductSummary>> {
  const summaries = new Map<string, GroupProductSummary>(
    productIds.map((id) => [
      id,
      { productId: id, itemCount: 0, statusCounts: {}, releases: [] },
    ]),
  );
  if (productIds.length === 0) return summaries;

  const [rows, done] = await Promise.all([
    tx
      .select({
        productId: features.productId,
        status: features.status,
        releaseId: features.releaseId,
        n: count(),
      })
      .from(features)
      .where(
        and(
          eq(features.workspaceId, ws),
          inArray(features.productId, productIds),
        ),
      )
      .groupBy(features.productId, features.status, features.releaseId),
    doneStatusesIn(tx, ws),
  ]);

  const releaseTotals = new Map<
    string,
    Map<string, { total: number; done: number }>
  >();
  for (const row of rows) {
    if (!row.productId) continue;
    const summary = summaries.get(row.productId);
    if (!summary) continue;
    const n = Number(row.n);
    summary.itemCount += n;
    summary.statusCounts[row.status] =
      (summary.statusCounts[row.status] ?? 0) + n;
    if (row.releaseId) {
      const byRelease =
        releaseTotals.get(row.productId) ??
        new Map<string, { total: number; done: number }>();
      releaseTotals.set(row.productId, byRelease);
      const entry = byRelease.get(row.releaseId) ?? { total: 0, done: 0 };
      entry.total += n;
      if (done.isDone(row.status, row.productId)) entry.done += n;
      byRelease.set(row.releaseId, entry);
    }
  }
  for (const [productId, byRelease] of releaseTotals) {
    const summary = summaries.get(productId);
    if (!summary) continue;
    summary.releases = [...byRelease.entries()].map(
      ([releaseId, { total, done }]) => ({ releaseId, total, done }),
    );
  }
  return summaries;
}

/**
 * The three escalation signals, each as a true count plus a capped sample.
 *
 * Every query is restricted to `readableIds`, so an unreadable product cannot
 * leak an item's title through a signal, and each excludes archived items and
 * anything already done (a blocker on finished work is history, not a signal).
 */
async function workspaceSignals(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  readableIds: string[],
  options: WorkspaceSummaryOptions,
): Promise<WorkspaceSignals> {
  const empty: WorkspaceSignals = {
    blocked: [],
    overdue: [],
    stale: [],
    counts: { blocked: 0, overdue: 0, stale: 0 },
  };
  if (readableIds.length === 0) return empty;

  const inScope = and(
    eq(features.workspaceId, ws),
    inArray(features.productId, readableIds),
    ne(features.status, "archived"),
    ne(features.status, "done"),
  );
  const select = {
    specId: features.specId,
    title: features.title,
    level: features.level,
    status: features.status,
    productId: features.productId,
    releaseId: features.releaseId,
    updatedAt: features.updatedAt,
  };

  const staleDays = options.staleDays ?? 14;
  const todayMs = Date.parse(`${options.today}T00:00:00Z`);
  // A malformed `today` would silently make everything (or nothing) overdue,
  // so refuse rather than reporting a number nobody can trust.
  if (Number.isNaN(todayMs)) {
    throw new Error(`getWorkspaceSummary: invalid today "${options.today}"`);
  }
  const staleBefore = new Date(todayMs - staleDays * 24 * 60 * 60 * 1000);

  const [blockedRows, overdueRows, staleRows] = await Promise.all([
    // Blocked: an inbound `blocks` edge. The edge is stored one way only
    // (from blocks to), so "blocked" is the to_feature_id side.
    tx
      .selectDistinct(select)
      .from(features)
      .innerJoin(featureLinks, eq(featureLinks.toFeatureId, features.id))
      .where(and(inScope, eq(featureLinks.type, "blocks")))
      .orderBy(asc(features.updatedAt)),
    // Past target: the release it ships in was due before today.
    tx
      .select(select)
      .from(features)
      .innerJoin(releases, eq(releases.id, features.releaseId))
      .where(
        and(
          inScope,
          ne(releases.status, "shipped"),
          lt(releases.targetDate, options.today),
        ),
      )
      .orderBy(asc(releases.targetDate)),
    // Stale: in flight by the caller's definition, untouched for staleDays.
    options.activeStatuses.length === 0
      ? Promise.resolve([])
      : tx
          .select(select)
          .from(features)
          .where(
            and(
              inScope,
              inArray(features.status, options.activeStatuses),
              lt(features.updatedAt, staleBefore),
            ),
          )
          .orderBy(asc(features.updatedAt)),
  ]);

  const item = (row: (typeof blockedRows)[number]): SignalItem => ({
    specId: row.specId,
    title: row.title,
    level: row.level,
    status: row.status,
    productId: row.productId,
    releaseId: row.releaseId,
  });
  const withAge = (row: (typeof staleRows)[number]): SignalItem => ({
    ...item(row),
    staleDays: Math.floor(
      (todayMs - row.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
    ),
  });

  return {
    blocked: blockedRows.slice(0, SIGNAL_SAMPLE_LIMIT).map(item),
    overdue: overdueRows.slice(0, SIGNAL_SAMPLE_LIMIT).map(item),
    stale: staleRows.slice(0, SIGNAL_SAMPLE_LIMIT).map(withAge),
    counts: {
      blocked: blockedRows.length,
      overdue: overdueRows.length,
      stale: staleRows.length,
    },
  };
}

function groupRecord(
  row: typeof productGroups.$inferSelect,
  counts: Map<string, number>,
): ProductGroupRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    color: row.color,
    parentId: row.parentId,
    position: row.position,
    productCount: counts.get(row.id) ?? 0,
  };
}
