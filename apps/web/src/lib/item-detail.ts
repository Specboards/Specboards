import "server-only";

import {
  childLevelKey,
  parentLevelKey,
  propertyAppliesToLevel,
  type PropertyDef,
  type StatusWorkflow,
} from "@specboard/core";

import { ALL_PRODUCTS } from "@/lib/active-product";
import { getDb } from "@/lib/db";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import type {
  FeatureDetail,
  ReleaseRecord,
  StageGate,
  WorkspaceScope,
} from "@/lib/store/types";
import {
  listWorkspaceMembers,
  type MemberRole,
  type WorkspaceMember,
} from "@/lib/workspace";
import { canEditProducts } from "@/lib/workspace-access";

/**
 * Tenant scope plus the caller's role — the minimum the detail resolver needs
 * to fetch data and decide edit rights. Satisfied by both a page's `PageAccess`
 * and the API route's resolved read access. `null` is local file mode.
 */
export type ItemDetailAccess = (WorkspaceScope & { role: MemberRole }) | null;

/** A lightweight {specId,title} pick used by the parent/relation selectors. */
export interface ItemRef {
  specId: string;
  title: string;
}

/**
 * Everything the item detail UI needs, resolved once on the server. Shared by
 * the full item page and the flyout's context endpoint so both render the exact
 * same layout from the same data. All fields are JSON-serializable.
 */
export interface ItemDetailData {
  feature: FeatureDetail;
  members: WorkspaceMember[];
  /** Custom properties that apply at this item's level. */
  properties: PropertyDef[];
  releases: ReleaseRecord[];
  workflow: StatusWorkflow;
  /** Exit-criteria gates for the item's *current* stage, in checklist order. */
  stageGates: StageGate[];
  /** Which of `stageGates` are checked off for this item. */
  completedGateIds: string[];
  canEdit: boolean;
  /** Built-in field keys available at this level; null = all. */
  availableFields: string[] | null;
  levelLabel: string;
  /** The item's current product slug (for building permalinks / redirects). */
  productSlug: string;
  parentKey: string | null;
  parentLevelLabel: string | null;
  childKey: string | null;
  childLabel: string | null;
  /** Items one level up that may be this item's parent (excludes descendants). */
  parentCandidates: ItemRef[];
  /** Other items this one can relate to (everything but itself). */
  relationCandidates: ItemRef[];
}

/**
 * Resolve the full detail bundle for `specId`, or null when it doesn't exist /
 * isn't visible to the caller. Mirrors what the item page assembles inline so
 * the flyout can render identical content from one round-trip.
 */
export async function getItemDetailData(
  specId: string,
  access: ItemDetailAccess,
): Promise<ItemDetailData | null> {
  const store = await getStore();
  const feature = await store.getFeature(specId, access ?? undefined);
  if (!feature) return null;

  const db = getDb();
  const members: WorkspaceMember[] =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];
  const workflow = await resolveWorkflowFor(access);

  const [allProperties, releases, allFeatures, levels, products, allGates, allCompletedGateIds] =
    await Promise.all([
      store.listProperties(access ?? undefined),
      store.listReleases(access ?? undefined),
      store.listFeatures(access ?? undefined),
      store.listLevels(access ?? undefined),
      store.listProducts(access ?? undefined),
      store.listStageGates(access ?? undefined),
      store.listGateCompletions(feature.specId, access ?? undefined),
    ]);

  // Only the current stage's gates are actionable on the item (exit criteria),
  // and completedGateIds is scoped to those so it matches stageGates 1:1.
  const stageGates = allGates.filter((g) => g.stageKey === feature.status);
  const stageGateIds = new Set(stageGates.map((g) => g.id));
  const completedGateIds = allCompletedGateIds.filter((id) =>
    stageGateIds.has(id),
  );

  const properties = allProperties.filter((p) =>
    propertyAppliesToLevel(p, feature.level),
  );

  const productSlug =
    products.find((p) => p.id === feature.productId)?.key ?? ALL_PRODUCTS;

  const levelLabel =
    levels.find((l) => l.key === feature.level)?.label ?? feature.level;
  const parentKey = parentLevelKey(feature.level, levels);
  const parentLevelLabel =
    levels.find((l) => l.key === parentKey)?.label ?? null;
  const childKey = childLevelKey(feature.level, levels);
  const childLabel = levels.find((l) => l.key === childKey)?.label ?? null;

  const descendants = descendantSpecIds(feature.specId, allFeatures);
  const parentCandidates = parentKey
    ? allFeatures
        .filter((f) => f.level === parentKey && !descendants.has(f.specId))
        .map((f) => ({ specId: f.specId, title: f.title }))
    : [];
  const relationCandidates = allFeatures
    .filter((f) => f.specId !== feature.specId)
    .map((f) => ({ specId: f.specId, title: f.title }));

  const canEdit = canEditProducts(access, products, feature.productId);
  const availableFields =
    levels.find((l) => l.key === feature.level)?.fields ?? null;

  return {
    feature,
    members,
    properties,
    releases,
    workflow,
    stageGates,
    completedGateIds,
    canEdit,
    availableFields,
    levelLabel,
    productSlug,
    parentKey,
    parentLevelLabel,
    childKey,
    childLabel,
    parentCandidates,
    relationCandidates,
  };
}

/** Spec ids of all features below `rootSpecId` in the parent/child tree. */
export function descendantSpecIds(
  rootSpecId: string,
  features: { specId: string; parentSpecId: string | null }[],
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const f of features) {
    if (!f.parentSpecId) continue;
    const arr = childrenOf.get(f.parentSpecId) ?? [];
    arr.push(f.specId);
    childrenOf.set(f.parentSpecId, arr);
  }
  const out = new Set<string>();
  const queue = [rootSpecId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (out.has(child)) continue; // guard against malformed cycles
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}
