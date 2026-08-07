import "server-only";

import {
  childLevelKey,
  parentLevelKey,
  propertyAppliesToLevel,
  type DetailTemplate,
  type PropertyDef,
  type StatusWorkflow,
} from "@specboards/core";

import { ALL_PRODUCTS } from "@/lib/active-product";
import { getDb } from "@/lib/db";
import {
  listLinkableRepos,
  type LinkableRepo,
} from "@/lib/github-links-service";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import type {
  CycleRecord,
  FeatureDetail,
  ItemGoalRef,
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
  /** Cycles (sprints) offered by the item's cycle picker. */
  cycles: CycleRecord[];
  /** Goals this item ladders up to (many-to-many; any level can link). */
  goals: ItemGoalRef[];
  /** Goals the item could be linked to, for the "Link goal" picker. */
  linkableGoals: { id: string; title: string }[];
  workflow: StatusWorkflow;
  /** Exit-criteria gates for the item's *current* stage, in checklist order. */
  stageGates: StageGate[];
  /** Which of `stageGates` are checked off for this item. */
  completedGateIds: string[];
  canEdit: boolean;
  /**
   * Whether this item's Markdown body may be edited *as a spec*, meaning the
   * save commits to git rather than to the database. Needs product-write, a
   * spec-backed item, a repo file to write to, and a database-backed
   * deployment (the git write has neither a repo record nor a scope to
   * authorize against in local file mode).
   *
   * Separate from `canEdit` because the two save paths are not interchangeable:
   * a DB-native card's body autosaves to the database, while a spec body is a
   * commit.
   */
  canEditSpec: boolean;
  /**
   * Whether this item can have a spec *attached* to it: it is tracked in the
   * app only, sits at the leaf level (the sync would reconcile a grouping back
   * down and silently demote it), the caller can write its product, and there
   * is a connected repo to commit the file to. Offering the action anywhere
   * else would show a button the server is going to refuse.
   */
  canAttachSpec: boolean;
  /**
   * Whether a brand-new spec can be created *beneath* this item, i.e. its
   * children are at the leaf level and there is a repo to write to.
   */
  canCreateChildSpec: boolean;
  /** The acting user's id (for author-only affordances like deleting a
   * comment); null in local file mode where there is no authenticated user. */
  currentUserId: string | null;
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
  /**
   * Connected repos, for the GitHub link form when a card's repo is ambiguous
   * and for choosing where a new spec file is committed. Spec repo first.
   */
  repos: LinkableRepo[];
  /**
   * Templates a new spec can start from, for the "New spec" picker. Empty when
   * no spec can be created here, so its absence is not "none configured".
   */
  specTemplates: DetailTemplate[];
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

  const [allProperties, releases, cycles, itemGoals, allGoals, allFeatures, levels, products, allGates, allCompletedGateIds] =
    await Promise.all([
      store.listProperties(access ?? undefined, "item"),
      store.listReleases(access ?? undefined),
      store.listCycles(access ?? undefined),
      store.listItemGoals(feature.specId, access ?? undefined),
      store.listGoals(access ?? undefined),
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
  // A spec-backed body is written by committing to the connected repo, so it
  // needs more than product-write: a file to write to, and the cloud
  // deployment that holds the repo record. `access` is null in file mode.
  const canEditSpec =
    canEdit && !feature.isDbNative && feature.path !== "" && access !== null;
  const availableFields =
    levels.find((l) => l.key === feature.level)?.fields ?? null;

  // Offered to the link form so a DB-native card in a multi-repo workspace can
  // say which repo a PR lives in; the form hides the picker for a single repo.
  // Also gates the spec-create affordances: with no connected repo there is
  // nowhere to commit a spec file, so the server would refuse.
  const repos = access ? await listLinkableRepos(access.workspaceId) : [];

  // Specs live at the leaf level only, so "attach" is offered on a leaf card
  // and "new spec" on the level directly above one.
  const canAttachSpec =
    canEdit &&
    feature.isDbNative &&
    childKey === null &&
    access !== null &&
    repos.length > 0;
  const canCreateChildSpec =
    canEdit &&
    childKey !== null &&
    childLevelKey(childKey, levels) === null &&
    access !== null &&
    repos.length > 0;

  // Starting points for a new spec, offered only where one can be created. The
  // same templates admins already maintain in Settings -> Cards, not a second
  // parallel set: "the team's sections" is one idea, wherever the Markdown ends
  // up. Skipped entirely when no create affordance shows, so an ordinary item
  // read does not pay for a query nothing renders.
  const specTemplates = canCreateChildSpec
    ? await store.listDetailTemplates(access ?? undefined)
    : [];

  return {
    feature,
    members,
    properties,
    releases,
    cycles,
    goals: itemGoals,
    // A goal can be served by work from any product, so the picker is not
    // narrowed to the item's own: cross-product linkage is the point.
    linkableGoals: allGoals
      .filter((g) => !itemGoals.some((ig) => ig.goalId === g.id))
      .map((g) => ({ id: g.id, title: g.title })),
    workflow,
    stageGates,
    completedGateIds,
    canEdit,
    canEditSpec,
    canAttachSpec,
    canCreateChildSpec,
    currentUserId: access?.userId ?? null,
    availableFields,
    levelLabel,
    productSlug,
    parentKey,
    parentLevelLabel,
    childKey,
    childLabel,
    parentCandidates,
    relationCandidates,
    repos,
    specTemplates,
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
