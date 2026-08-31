/**
 * Products, product groups, members, and the roll-up summaries over them, in
 * local file mode.
 *
 * The domain that shows the two stores' difference most plainly. In Postgres
 * this module owns five of the seven context members, because every one of them
 * is a question about who may reach which product. Here there is one user with
 * `LOCAL_PRODUCT_ACCESS` to everything, so those questions have constant
 * answers and what is left is the data: products, groups, and the counting.
 *
 * The group roll-up still covers a whole subtree rather than direct children,
 * which is why `descendantGroupIds` appears here as it does in db/products.ts.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_PRODUCT_KEY,
  LOCAL_PRODUCT_ACCESS,
  descendantGroupIds,
  groupKeyFromName,
  productKeyFromName,
  wouldCreateCycle,
  wouldExceedDepth,
} from "@specboards/core";

import {
  type BlockingEdge,
  type CreateProductGroupInput,
  type CreateProductInput,
  GroupError,
  type GroupProductSummary,
  type GroupSummary,
  type ProductAccess,
  ProductError,
  type ProductGroupPatch,
  type ProductGroupRecord,
  type ProductMemberInput,
  type ProductMemberRecord,
  type ProductPatch,
  type ProductRecord,
  SIGNAL_SAMPLE_LIMIT,
  type SignalItem,
  type WorkspaceScope,
  type WorkspaceSummary,
  type WorkspaceSummaryOptions,
} from "../types";

import { isDone, type LocalStoreContext } from "./context";
import { listReleases } from "./releases";
import { localPath } from "./paths";

// Products. Local file mode is a single all-powerful user (see core
// LOCAL_PRODUCT_ACCESS), so visibility/permissions aren't enforced; products
// persist to `.specboards/local-products.json` for switcher parity.
export async function getProductAccess(
  _scope?: WorkspaceScope,
): Promise<ProductAccess> {
  return LOCAL_PRODUCT_ACCESS;
}

export async function listProducts(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<ProductRecord[]> {
  const [products, counts] = await Promise.all([
    readProducts(ctx),
    productItemCounts(ctx),
  ]);
  return products
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((p) => toProductRecord(p, counts));
}

export async function getProduct(
  ctx: LocalStoreContext,
  key: string,
  _scope?: WorkspaceScope,
): Promise<ProductRecord | null> {
  const products = await readProducts(ctx);
  const p = products.find((x) => x.key === key);
  if (!p) return null;
  return toProductRecord(p, await productItemCounts(ctx));
}

export async function createProduct(
  ctx: LocalStoreContext,
  input: CreateProductInput,
  _scope?: WorkspaceScope,
): Promise<ProductRecord> {
  const name = input.name.trim();
  if (!name) throw new ProductError("Product name is required.");
  const products = await readProducts(ctx);
  const key = productKeyFromName(name, new Set(products.map((p) => p.key)));
  const product: LocalProduct = {
    id: randomUUID(),
    key,
    name,
    description: input.description ?? null,
    visibility: input.visibility ?? "org",
    color: input.color ?? null,
    position: products.reduce((m, p) => Math.max(m, p.position), -1) + 1,
  };
  await writeProducts(ctx, [...products, product]);
  return toProductRecord(product, new Map());
}

export async function updateProduct(
  ctx: LocalStoreContext,
  id: string,
  patch: ProductPatch,
  _scope?: WorkspaceScope,
): Promise<ProductRecord> {
  const products = await readProducts(ctx);
  const p = products.find((x) => x.id === id);
  if (!p) throw new ProductError(`Unknown product: ${id}`);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new ProductError("Product name is required.");
    p.name = name;
  }
  if (patch.description !== undefined) p.description = patch.description;
  if (patch.visibility !== undefined) p.visibility = patch.visibility;
  if (patch.position !== undefined) p.position = patch.position;
  if (patch.color !== undefined) p.color = patch.color;
  if (patch.groupId !== undefined) {
    if (patch.groupId !== null) {
      const groups = await readGroups(ctx);
      if (!groups.some((g) => g.id === patch.groupId)) {
        throw new GroupError(`Unknown product group: ${patch.groupId}`);
      }
    }
    p.groupId = patch.groupId;
  }
  await writeProducts(ctx, products);
  return toProductRecord(p, await productItemCounts(ctx));
}

export async function deleteProduct(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const counts = await productItemCounts(ctx);
  if ((counts.get(id) ?? 0) > 0) {
    throw new ProductError(
      "Can't delete a product while it still has work items.",
    );
  }
  const products = await readProducts(ctx);
  if (!products.some((p) => p.id === id))
    throw new ProductError(`Unknown product: ${id}`);
  await writeProducts(
    ctx,
    products.filter((p) => p.id !== id),
  );
}

export async function listProductGroups(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<ProductGroupRecord[]> {
  const [groups, products] = await Promise.all([
    readGroups(ctx),
    readProducts(ctx),
  ]);
  return groups
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((g) => ({
      ...g,
      productCount: products.filter((p) => p.groupId === g.id).length,
    }));
}

export async function createProductGroup(
  ctx: LocalStoreContext,
  input: CreateProductGroupInput,
  _scope?: WorkspaceScope,
): Promise<ProductGroupRecord> {
  const name = input.name.trim();
  if (!name) throw new GroupError("Group name is required.");
  const groups = await readGroups(ctx);
  const parentId = input.parentId ?? null;
  if (parentId) {
    if (!groups.some((g) => g.id === parentId)) {
      throw new GroupError(`Unknown product group: ${parentId}`);
    }
    if (wouldExceedDepth(groups, "new-group", parentId)) {
      throw new GroupError("Groups can only be nested a few levels deep.");
    }
  }
  const group: LocalProductGroup = {
    id: randomUUID(),
    key: groupKeyFromName(name, new Set(groups.map((g) => g.key))),
    name,
    description: input.description ?? null,
    color: input.color ?? null,
    parentId,
    position: groups.reduce((m, g) => Math.max(m, g.position), -1) + 1,
  };
  await writeGroups(ctx, [...groups, group]);
  return { ...group, productCount: 0 };
}

export async function updateProductGroup(
  ctx: LocalStoreContext,
  id: string,
  patch: ProductGroupPatch,
  _scope?: WorkspaceScope,
): Promise<ProductGroupRecord> {
  const groups = await readGroups(ctx);
  const g = groups.find((x) => x.id === id);
  if (!g) throw new GroupError(`Unknown product group: ${id}`);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new GroupError("Group name is required.");
    g.name = name;
  }
  if (patch.description !== undefined) g.description = patch.description;
  if (patch.color !== undefined) g.color = patch.color;
  if (patch.position !== undefined) g.position = patch.position;
  if (patch.parentId !== undefined) {
    if (patch.parentId !== null) {
      if (!groups.some((x) => x.id === patch.parentId)) {
        throw new GroupError(`Unknown product group: ${patch.parentId}`);
      }
      if (wouldCreateCycle(groups, id, patch.parentId)) {
        throw new GroupError(
          "A group can't be nested inside itself or its own subgroups.",
        );
      }
      if (wouldExceedDepth(groups, id, patch.parentId)) {
        throw new GroupError("Groups can only be nested a few levels deep.");
      }
    }
    g.parentId = patch.parentId;
  }
  await writeGroups(ctx, groups);
  const products = await readProducts(ctx);
  return {
    ...g,
    productCount: products.filter((p) => p.groupId === g.id).length,
  };
}

export async function deleteProductGroup(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const groups = await readGroups(ctx);
  if (!groups.some((g) => g.id === id)) {
    throw new GroupError(`Unknown product group: ${id}`);
  }
  if (groups.some((g) => g.parentId === id)) {
    throw new GroupError("Can't delete a group while it still has subgroups.");
  }
  const products = await readProducts(ctx);
  if (products.some((p) => p.groupId === id)) {
    throw new GroupError("Can't delete a group while it still has products.");
  }
  await writeGroups(
    ctx,
    groups.filter((g) => g.id !== id),
  );
}

export async function getGroupSummary(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<GroupSummary> {
  const [groups, products, allFeatures] = await Promise.all([
    readGroups(ctx),
    readProducts(ctx),
    ctx.loadAll(),
  ]);
  const group = groups.find((g) => g.id === id);
  if (!group) throw new GroupError(`Unknown product group: ${id}`);

  const subtree = descendantGroupIds(groups, id);
  const member = products.filter((p) => p.groupId && subtree.has(p.groupId));
  const summaries = new Map<string, GroupProductSummary>(
    member.map((p) => [
      p.id,
      { productId: p.id, itemCount: 0, statusCounts: {}, releases: [] },
    ]),
  );
  const releaseTotals = new Map<
    string,
    Map<string, { total: number; done: number }>
  >();
  for (const f of allFeatures) {
    if (!f.productId) continue;
    const summary = summaries.get(f.productId);
    if (!summary) continue;
    summary.itemCount += 1;
    summary.statusCounts[f.status] = (summary.statusCounts[f.status] ?? 0) + 1;
    if (f.releaseId) {
      const byRelease =
        releaseTotals.get(f.productId) ??
        new Map<string, { total: number; done: number }>();
      releaseTotals.set(f.productId, byRelease);
      const entry = byRelease.get(f.releaseId) ?? { total: 0, done: 0 };
      entry.total += 1;
      if (f.status === "done") entry.done += 1;
      byRelease.set(f.releaseId, entry);
    }
  }
  for (const [productId, byRelease] of releaseTotals) {
    const summary = summaries.get(productId);
    if (!summary) continue;
    summary.releases = [...byRelease.entries()].map(
      ([releaseId, { total, done }]) => ({ releaseId, total, done }),
    );
  }

  const productCount = (gid: string) =>
    products.filter((p) => p.groupId === gid).length;
  return {
    group: { ...group, productCount: productCount(group.id) },
    subgroups: groups
      .filter((g) => g.parentId === id)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((g) => ({ ...g, productCount: productCount(g.id) })),
    products: [...member]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((p) => summaries.get(p.id)!),
  };
}

export async function listBlockingEdges(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<BlockingEdge[]> {
  const [meta, features] = await Promise.all([
    ctx.readMetadata(),
    ctx.loadAll(),
  ]);
  const known = new Set(features.map((f) => f.specId));
  const out: BlockingEdge[] = [];
  for (const [fromSpec, m] of Object.entries(meta)) {
    for (const link of m.links ?? []) {
      // Same rule as the relation counts: both ends must resolve to a real
      // item, so a link to a deleted spec is not drawn.
      if (link.type !== "blocks") continue;
      if (!known.has(fromSpec) || !known.has(link.to)) continue;
      out.push({ blockerSpecId: fromSpec, blockedSpecId: link.to });
    }
  }
  return out;
}

export async function getWorkspaceSummary(
  ctx: LocalStoreContext,
  options: WorkspaceSummaryOptions,
  _scope?: WorkspaceScope,
): Promise<WorkspaceSummary> {
  const [products, allFeatures, releases, doneKey] = await Promise.all([
    readProducts(ctx),
    ctx.loadAll(),
    listReleases(ctx),
    ctx.doneStatusKey(),
  ]);

  // Same aggregation as getGroupSummary, over every product rather than one
  // subtree. File mode is single-user, so everything is readable.
  const summaries = new Map<string, GroupProductSummary>(
    products.map((p) => [
      p.id,
      { productId: p.id, itemCount: 0, statusCounts: {}, releases: [] },
    ]),
  );
  const releaseTotals = new Map<
    string,
    Map<string, { total: number; done: number }>
  >();
  for (const f of allFeatures) {
    if (!f.productId) continue;
    const summary = summaries.get(f.productId);
    if (!summary) continue;
    summary.itemCount += 1;
    summary.statusCounts[f.status] = (summary.statusCounts[f.status] ?? 0) + 1;
    if (f.releaseId) {
      const byRelease =
        releaseTotals.get(f.productId) ??
        new Map<string, { total: number; done: number }>();
      releaseTotals.set(f.productId, byRelease);
      const entry = byRelease.get(f.releaseId) ?? { total: 0, done: 0 };
      entry.total += 1;
      if (isDone(f.status, doneKey)) entry.done += 1;
      byRelease.set(f.releaseId, entry);
    }
  }
  for (const [productId, byRelease] of releaseTotals) {
    const summary = summaries.get(productId);
    if (!summary) continue;
    summary.releases = [...byRelease.entries()].map(
      ([releaseId, { total, done }]) => ({ releaseId, total, done }),
    );
  }

  const live = allFeatures.filter(
    (f) => f.status !== "archived" && !isDone(f.status, doneKey),
  );
  const signal = (f: (typeof live)[number]): SignalItem => ({
    specId: f.specId,
    title: f.title,
    level: f.level,
    status: f.status,
    productId: f.productId,
    releaseId: f.releaseId,
  });
  const overdueReleases = new Set(
    releases
      .filter(
        (r) =>
          r.status !== "shipped" &&
          r.targetDate !== null &&
          r.targetDate < options.today,
      )
      .map((r) => r.id),
  );
  const blocked = live.filter((f) => f.blockedByCount > 0).map(signal);
  const overdue = live
    .filter((f) => f.releaseId && overdueReleases.has(f.releaseId))
    .map(signal);
  // File mode keeps no per-item updated_at, so staleness is unknowable here.
  // Reporting an empty list is honest; inventing one from file mtimes would
  // measure when the repo was cloned, not when the work last moved.
  return {
    products: [...products]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((p) => summaries.get(p.id)!),
    signals: {
      blocked: blocked.slice(0, SIGNAL_SAMPLE_LIMIT),
      overdue: overdue.slice(0, SIGNAL_SAMPLE_LIMIT),
      stale: [],
      counts: {
        blocked: blocked.length,
        overdue: overdue.length,
        stale: 0,
      },
    },
  };
}

// Membership needs real user records, which file mode doesn't have.
export async function listProductMembers(
  _productId: string,
  _scope?: WorkspaceScope,
): Promise<ProductMemberRecord[]> {
  return [];
}

export async function setProductMember(
  _productId: string,
  _input: ProductMemberInput,
  _scope?: WorkspaceScope,
): Promise<void> {
  throw new ProductError(
    "Managing product members requires authentication (not available in local file mode).",
  );
}

export async function removeProductMember(
  _productId: string,
  _userId: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  // Nothing to remove in file mode.
}

/** Persisted products, seeded with the default product when none exist. */
async function readProducts(ctx: LocalStoreContext): Promise<LocalProduct[]> {
  try {
    const rows = JSON.parse(
      await fs.readFile(localPath(ctx.root, "products"), "utf8"),
    ) as LocalProduct[];
    if (rows.length > 0) return rows;
  } catch {
    /* fall through to the seed */
  }
  return [{ ...LOCAL_DEFAULT_PRODUCT }];
}

async function writeProducts(
  ctx: LocalStoreContext,
  rows: LocalProduct[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "products")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "products"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

async function readGroups(
  ctx: LocalStoreContext,
): Promise<LocalProductGroup[]> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "productGroups"), "utf8"),
    ) as LocalProductGroup[];
  } catch {
    return [];
  }
}

async function writeGroups(
  ctx: LocalStoreContext,
  rows: LocalProductGroup[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "productGroups")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "productGroups"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

/** Item counts per product, derived from all features (specs + items). */
async function productItemCounts(
  ctx: LocalStoreContext,
): Promise<Map<string, number>> {
  const features = await ctx.loadAll();
  const out = new Map<string, number>();
  for (const f of features) {
    if (f.productId) out.set(f.productId, (out.get(f.productId) ?? 0) + 1);
  }
  return out;
}

function toProductRecord(
  p: LocalProduct,
  counts: Map<string, number>,
): ProductRecord {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    visibility: p.visibility,
    position: p.position,
    color: p.color ?? null,
    groupId: p.groupId ?? null,
    itemCount: counts.get(p.id) ?? 0,
    viewerRole: null,
  };
}

/** A product (sibling backlog) persisted in local file mode. */
interface LocalProduct {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: "org" | "private";
  position: number;
  color?: string | null;
  groupId?: string | null;
}

/** A product group persisted in local file mode. */
interface LocalProductGroup {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  parentId: string | null;
  position: number;
}

/** The default product seeded when none is persisted (id is stable). */
const LOCAL_DEFAULT_PRODUCT: LocalProduct = {
  id: "default",
  key: DEFAULT_PRODUCT_KEY,
  name: "General",
  description: null,
  visibility: "org",
  position: 0,
  color: null,
};

/** The default product id (the seeded "default", or the first product). */
export async function defaultProductId(
  ctx: LocalStoreContext,
): Promise<string> {
  const products = await readProducts(ctx);
  return (
    products.find((p) => p.key === DEFAULT_PRODUCT_KEY)?.id ??
    products[0]?.id ??
    LOCAL_DEFAULT_PRODUCT.id
  );
}
