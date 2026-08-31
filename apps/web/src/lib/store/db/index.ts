import { randomUUID } from "node:crypto";

import {
  canReadProduct,
  DEFAULT_PRODUCT_KEY,
  descendantGroupIds,
  extractSections,
  groupKeyFromName,
  wouldCreateCycle,
  wouldExceedDepth,
  isGeneratedGroupingTitle,
  isValidParentLevel,
  productKeyFromName,
  type IdeaStage,
  type PropertyDef,
  type PropertyEntity,
  type TransitionMode,
  type WorkspaceLevel,
} from "@specboards/core";

import { riceFields } from "@/lib/feature-helpers";
import {
  and,
  asc,
  comments,
  cycles,
  count,
  createDb,
  desc,
  eq,
  featureGithubLinks,
  featureLinks,
  features,
  inArray,
  itemEvents,
  lt,
  members,
  ne,
  or,
  outboxEvents,
  productGroups,
  productMembers,
  products,
  releases,
  repositories,
  sql,
  specIndex,
  users,
  type Database,
} from "@specboards/db";

import {
  FeatureError,
  GroupError,
  ProductError,
  RelationError,
  type CommentInput,
  type CommentRecord,
  type NotificationList,
  type BoardKey,
  type BoardPreferences,
  type CreateFeatureInput,
  type GoalContribution,
  type GoalInput,
  type GoalLinkRef,
  type GoalPatch,
  type GoalRecord,
  type ItemGoalRef,
  type KeyResultInput,
  type KeyResultPatch,
  type CycleGenerateInput,
  type CycleInput,
  type CyclePatch,
  type CycleRecord,
  type CycleRolloverResult,
  type CreateProductInput,
  type DeleteFeatureOptions,
  type DetailTemplate,
  type DetailTemplateInput,
  type DetailTemplatePatch,
  type DocArea,
  type DocPageInput,
  type DocPagePatch,
  type DocPageRecord,
  type DocSpace,
  type DocSpaceInput,
  type LevelUpdate,
  type OutboxEmit,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureRelation,
  type FeatureStore,
  type GithubLink,
  type GithubLinkAggregate,
  type GithubLinkKind,
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type CreateProductGroupInput,
  type BlockingEdge,
  type GroupProductSummary,
  type GroupSummary,
  SIGNAL_SAMPLE_LIMIT,
  type SignalItem,
  type WorkspaceSignals,
  type WorkspaceSummary,
  type WorkspaceSummaryOptions,
  type ProductAccess,
  type ProductGroupPatch,
  type ProductGroupRecord,
  type ProductMemberInput,
  type ProductMemberRecord,
  type ProductPatch,
  type ProductRecord,
  type PropertyInput,
  type PropertyPatch,
  type RelationDirection,
  type RelationInput,
  type ReleaseInput,
  type ReleasePatch,
  type ReleaseRecord,
  type StageGate,
  type StageGateInput,
  type CardsOverrides,
  type StatusStageInput,
  type TransitionModeSettings,
  type WorkspaceStatus,
  type ResolvedGithubLink,
  type SavedView,
  type SavedViewInput,
  type SavedViewPatch,
  type ActorType,
  type ActivityQuery,
  type ActivitySummary,
  type ItemEvent,
  type WorkspaceScope,
} from "../types";

import {
  canReadProductId,
  emptyAgg,
  canWriteProductId,
  doneStatusesIn,
  toCustomFields,
  type DbStoreContext,
  type ProductVisibilityRow,
  type Tx,
} from "./context";
import * as collabStore from "./collaboration";
import * as configStore from "./workspace-config";
import * as cycleStore from "./cycles";
import * as goalStore from "./goals";
import * as ideaStore from "./ideas";
import * as docStore from "./docs";
import * as releaseStore from "./releases";
import * as settingsStore from "./settings";
import * as viewStore from "./views";

type LinkRow = {
  id: string;
  fromFeatureId: string;
  toFeatureId: string;
  type: "blocks" | "relates_to" | "duplicates";
};

/** Resolve a stored link into the direction seen from `featureId`'s side. */
function directionFor(link: LinkRow, featureId: string): RelationDirection {
  const outgoing = link.fromFeatureId === featureId;
  switch (link.type) {
    case "blocks":
      return outgoing ? "blocks" : "blocked_by";
    case "duplicates":
      return outgoing ? "duplicates" : "duplicated_by";
    case "relates_to":
      return "relates_to";
  }
}

/** Tally one link into an aggregate (closed-not-merged PRs count in total only). */
function tallyLink(
  agg: GithubLinkAggregate,
  kind: GithubLinkKind,
  state: string | null,
): void {
  agg.total += 1;
  if (kind === "issue") agg.issues += 1;
  else if (kind === "branch") agg.branches += 1;
  else if (state === "merged") agg.mergedPrs += 1;
  else if (state === "open") agg.openPrs += 1;
}

/**
 * The status a sync-created Feature grouping carries. Sync's insert does not
 * set `status`, so the row takes the `features.status` column default; a
 * grouping still sitting at this value has never been moved by anyone.
 */
const SYNC_CREATED_STATUS = "backlog";

/** The item a ledger row is about, snapshotted as it was when it changed. */
interface ItemEventSubject {
  featureId: string;
  specId: string;
  title: string | null;
  productId: string | null;
}

/** One field's change, as the ledger records it. */
interface ItemFieldChange {
  field: string;
  before: unknown;
  after: unknown;
  /** Defaults to "item.field_changed". */
  type?: string;
}

/**
 * The item columns whose changes are worth remembering.
 *
 * `rank` is deliberately absent. It is board ordering, rewritten every time
 * anyone drags a card, and recording it would bury the changes people actually
 * mean by "who changed what" under thousands of rows that answer nobody's
 * question. `updatedAt` and `parentSetBy` are bookkeeping the change itself
 * implies, so they are not changes in their own right.
 */
const LEDGER_FIELDS = [
  "title",
  "status",
  "tags",
  "releaseId",
  "cycleId",
  "assigneeId",
  "customFields",
  "details",
  "parentId",
  "riceReach",
  "riceImpact",
  "riceConfidence",
  "riceEffort",
] as const;

/**
 * Compare a stored value with the one about to replace it.
 *
 * Tags and custom fields are arrays and objects, so identity is the wrong test
 * and would log a change every time a form round-trips an unmodified list.
 * Serializing is enough here because these are plain JSON values with stable
 * key order from the same code path on both sides.
 */
function sameLedgerValue(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (before === null || after === null || before === undefined || after === undefined) {
    return (before ?? null) === (after ?? null);
  }
  if (typeof before === "object" || typeof after === "object") {
    return JSON.stringify(before) === JSON.stringify(after);
  }
  return false;
}

/**
 * Which of the tracked fields this write actually changes.
 *
 * Driven by what is in `set` (the columns the update will really write) rather
 * than by the caller's patch, so a value the store normalized or ignored does
 * not get recorded as a change that never happened.
 */
function ledgerChanges(
  current: Record<string, unknown>,
  set: Record<string, unknown>,
): ItemFieldChange[] {
  const changes: ItemFieldChange[] = [];
  for (const field of LEDGER_FIELDS) {
    if (!(field in set)) continue;
    const before = current[field];
    const after = set[field];
    if (sameLedgerValue(before, after)) continue;
    changes.push({ field, before: before ?? null, after: after ?? null });
  }
  return changes;
}

/**
 * Postgres-backed store (self-host compose stack or hosted Postgres).
 *
 * Also implements `DbStoreContext`, the small surface the domain modules in
 * this directory call back into. That is why `scoped`, `accessIn` and
 * `requireProductId` are not `private`: they are internal to `lib/store/db/`,
 * not part of what a caller outside it should reach for.
 */
export class DbStore implements FeatureStore, DbStoreContext {
  private readonly db: Database;

  constructor(connectionString: string) {
    this.db = createDb(connectionString);
  }

  /**
   * Run `fn` inside a transaction scoped to `scope`: it sets the
   * `app.user_id` session variable RLS keys on (transaction-local, so it must
   * live in a transaction), and callers additionally filter by `workspaceId`.
   * Refuses to run unscoped because an unset `app.user_id` is not a safe
   * default: on a self-host without `DATABASE_URL_APP` this store is still the
   * owner connection, where every policy is bypassed and the `workspaceId`
   * predicate is all that stands between tenants.
   *
   * The `specboards_app` non-owner role has landed, so on a hosted deployment
   * the policies do apply here. This is the one connection where that is true.
   * See the note on `getDb()` in lib/db.ts for the paths where it is not.
   */
  async scoped<T>(
    scope: WorkspaceScope | undefined,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (!scope) {
      throw new Error("DbStore requires a workspace scope.");
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.user_id', ${scope.userId}, true)`,
      );
      return fn(tx);
    });
  }

  /**
   * Append a transactional-outbox row. Called from inside a mutating method's
   * `scoped` transaction so the event commits atomically with the change that
   * produced it. `actorId`/`workspaceId` come from the scope; the rest is the
   * caller's opaque event.
   */
  async writeOutbox(
    tx: Tx,
    scope: WorkspaceScope,
    emit: OutboxEmit,
  ): Promise<void> {
    await tx.insert(outboxEvents).values({
      workspaceId: scope.workspaceId,
      productId: emit.productId,
      actorId: scope.userId,
      type: emit.type,
      data: emit.data,
    });
  }

  /**
   * Append change-ledger rows, in the same transaction as the change itself so
   * a change can never exist without its record.
   *
   * One row per field, not one per request: a patch that moves an item's status
   * and reassigns it is two changes, and reverting or reporting on either one
   * separately is the whole point. A request that changes nothing writes
   * nothing, so re-saving a form does not pad the history.
   */
  private async writeItemEvents(
    tx: Tx,
    scope: WorkspaceScope,
    subject: ItemEventSubject,
    changes: ItemFieldChange[],
  ): Promise<void> {
    if (changes.length === 0) return;
    // An unstated actor is a person in the browser. Every other caller is
    // expected to say what it is; see WorkspaceScope.actor.
    const actor = scope.actor ?? { type: "user", id: scope.userId, label: null };
    await tx.insert(itemEvents).values(
      changes.map((c) => ({
        workspaceId: scope.workspaceId,
        featureId: subject.featureId,
        specId: subject.specId,
        itemTitle: subject.title,
        productId: subject.productId,
        actorType: actor.type,
        actorId: actor.id,
        actorLabel: actor.label,
        type: c.type ?? "item.field_changed",
        field: c.field,
        // jsonb, so `null` and "absent" are different things: null means the
        // field was genuinely cleared, which revert has to be able to reproduce.
        before: c.before ?? null,
        after: c.after ?? null,
      })),
    );
  }

  // ==========================================================================
  // Items: read
  // ==========================================================================

  async listFeatures(scope?: WorkspaceScope): Promise<FeatureRecord[]> {
    return this.scoped(scope, async (tx) => {
      const [allRows, access, productById] = await Promise.all([
        tx.query.features.findMany({
          where: eq(features.workspaceId, scope!.workspaceId),
          with: { index: true },
        }),
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, scope!.workspaceId),
      ]);
      const rows = allRows.filter((row) =>
        canReadProductId(access, productById, row.productId),
      );
      const visibleIds = new Set(rows.map((row) => row.id));
      const links = await tx
        .select({
          fromFeatureId: featureLinks.fromFeatureId,
          toFeatureId: featureLinks.toFeatureId,
        })
        .from(featureLinks)
        .where(
          and(
            eq(featureLinks.workspaceId, scope!.workspaceId),
            eq(featureLinks.type, "blocks"),
          ),
        );
      const visibleLinks = links.filter(
        (link) =>
          visibleIds.has(link.fromFeatureId) &&
          visibleIds.has(link.toFeatureId),
      );
      // One pass over the visible `blocks` edges to tally counts per row.
      const blocks = new Map<string, number>();
      const blockedBy = new Map<string, number>();
      for (const l of visibleLinks) {
        blocks.set(l.fromFeatureId, (blocks.get(l.fromFeatureId) ?? 0) + 1);
        blockedBy.set(l.toFeatureId, (blockedBy.get(l.toFeatureId) ?? 0) + 1);
      }
      // Hierarchy roll-up from the visible workspace set.
      const done = await doneStatusesIn(tx, scope!.workspaceId);
      const specById = new Map(rows.map((r) => [r.id, r.specId]));
      const childCount = new Map<string, number>();
      const childDone = new Map<string, number>();
      for (const r of rows) {
        if (!r.parentId || !visibleIds.has(r.parentId)) continue;
        childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
        if (done.isDone(r.status, r.productId))
          childDone.set(r.parentId, (childDone.get(r.parentId) ?? 0) + 1);
      }
      // GitHub link aggregate, rolled up over each visible feature's subtree.
      const ghLinks = (
        await tx
          .select({
            featureId: featureGithubLinks.featureId,
            kind: featureGithubLinks.kind,
            state: featureGithubLinks.state,
          })
          .from(featureGithubLinks)
          .where(eq(featureGithubLinks.workspaceId, scope!.workspaceId))
      ).filter((link) => visibleIds.has(link.featureId));
      const parentOf = new Map(
        rows.map((r) => [
          r.id,
          r.parentId && visibleIds.has(r.parentId) ? r.parentId : null,
        ]),
      );
      const ghAgg = new Map<string, GithubLinkAggregate>();
      for (const r of rows) ghAgg.set(r.id, emptyAgg());
      for (const link of ghLinks) {
        const seen = new Set<string>();
        let cur: string | null = link.featureId;
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          const agg = ghAgg.get(cur);
          if (agg) tallyLink(agg, link.kind, link.state);
          cur = parentOf.get(cur) ?? null;
        }
      }
      return rows.map((row) => ({
        specId: row.specId,
        title: row.title,
        level: row.level,
        // "No attached spec", derived from spec_index rather than repo_id: a
        // work item with no spec has no repo either, so the two only look alike
        // until human work items exist. See ADR 0003 D2.
        isDbNative: row.index == null,
        productId: row.productId,
        status: row.status,
        rank: row.rank,
        tags: row.tags,
        releaseId: row.releaseId,
        cycleId: row.cycleId,
        assigneeId: row.assigneeId,
        customFields: toCustomFields(row.customFields),
        ...riceFields({
          riceReach: row.riceReach,
          riceImpact: row.riceImpact,
          riceConfidence: row.riceConfidence,
          riceEffort: row.riceEffort,
        }),
        path: row.index?.path ?? "",
        blocksCount: blocks.get(row.id) ?? 0,
        blockedByCount: blockedBy.get(row.id) ?? 0,
        parentSpecId: row.parentId
          ? (specById.get(row.parentId) ?? null)
          : null,
        childCount: childCount.get(row.id) ?? 0,
        childDoneCount: childDone.get(row.id) ?? 0,
        githubSummary: ghAgg.get(row.id) ?? emptyAgg(),
      }));
    });
  }

  async listFeatureBodies(
    specIds: readonly string[],
    scope?: WorkspaceScope,
  ): Promise<Map<string, string>> {
    if (specIds.length === 0) return new Map();
    return this.scoped(scope, async (tx) => {
      const rows = await tx.query.features.findMany({
        where: and(
          eq(features.workspaceId, scope!.workspaceId),
          inArray(features.specId, [...specIds]),
        ),
        with: { index: true },
      });
      const [access, productById] = await Promise.all([
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, scope!.workspaceId),
      ]);
      const out = new Map<string, string>();
      for (const row of rows) {
        // The same visibility decision `getFeature` makes, made here too rather
        // than trusted to the caller: this is a bulk read of item *content*, and
        // a product the caller cannot open must not leak through it.
        if (!canReadProductId(access, productById, row.productId)) continue;
        // Spec-backed items read their body from spec_index; DB-native items
        // keep it inline on features.details. Same resolution as getFeature.
        const content = row.index?.content ?? row.details ?? "";
        if (content) out.set(row.specId, content);
      }
      return out;
    });
  }

  async getFeature(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<FeatureDetail | null> {
    return this.scoped(scope, async (tx) => {
      const row = await tx.query.features.findFirst({
        where: and(
          eq(features.specId, specId),
          eq(features.workspaceId, scope!.workspaceId),
        ),
        with: { index: true },
      });
      if (!row) return null;
      const [access, productById] = await Promise.all([
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, scope!.workspaceId),
      ]);
      if (!canReadProductId(access, productById, row.productId)) return null;
      // Spec-backed items read their body from spec_index; DB-native items
      // (initiatives/epics) keep it inline on features.details.
      const content = row.index?.content ?? row.details ?? "";
      // Resolve the assignee's display name (separate lookup, since there's no
      // features→users relation, and assignees are usually few).
      let assigneeName: string | null = null;
      if (row.assigneeId) {
        const assignee = await tx.query.users.findFirst({
          where: eq(users.id, row.assigneeId),
          columns: { name: true },
        });
        assigneeName = assignee?.name ?? null;
      }

      // Relations touching this feature (either end), resolved to its POV.
      const links = (await tx
        .select({
          id: featureLinks.id,
          fromFeatureId: featureLinks.fromFeatureId,
          toFeatureId: featureLinks.toFeatureId,
          type: featureLinks.type,
        })
        .from(featureLinks)
        .where(
          and(
            eq(featureLinks.workspaceId, scope!.workspaceId),
            or(
              eq(featureLinks.fromFeatureId, row.id),
              eq(featureLinks.toFeatureId, row.id),
            ),
          ),
        )) as LinkRow[];
      const otherIds = links.map((l) =>
        l.fromFeatureId === row.id ? l.toFeatureId : l.fromFeatureId,
      );
      const others = otherIds.length
        ? await tx
            .select({
              id: features.id,
              specId: features.specId,
              title: features.title,
              level: features.level,
              productId: features.productId,
            })
            .from(features)
            .where(
              and(
                eq(features.workspaceId, scope!.workspaceId),
                inArray(features.id, otherIds),
              ),
            )
        : [];
      const byId = new Map(
        others
          .filter((o) => canReadProductId(access, productById, o.productId))
          .map((o) => [o.id, o]),
      );
      const relations: FeatureRelation[] = links
        .map((l) => {
          const otherId =
            l.fromFeatureId === row.id ? l.toFeatureId : l.fromFeatureId;
          const other = byId.get(otherId);
          if (!other) return null;
          return {
            id: l.id,
            direction: directionFor(l, row.id),
            otherSpecId: other.specId,
            otherTitle: other.title,
            otherLevel: other.level,
          } satisfies FeatureRelation;
        })
        .filter((r): r is FeatureRelation => r !== null);

      // Parent (one lookup) + direct children for the hierarchy view.
      let parentSpecId: string | null = null;
      let parentTitle: string | null = null;
      if (row.parentId) {
        const parent = await tx.query.features.findFirst({
          where: and(
            eq(features.id, row.parentId),
            eq(features.workspaceId, scope!.workspaceId),
          ),
          columns: { specId: true, title: true, productId: true },
        });
        if (parent && canReadProductId(access, productById, parent.productId)) {
          parentSpecId = parent.specId;
          parentTitle = parent.title;
        }
      }
      const [childRowsRaw, done] = await Promise.all([
        tx
          .select({
            specId: features.specId,
            title: features.title,
            status: features.status,
            productId: features.productId,
          })
          .from(features)
          .where(
            and(
              eq(features.parentId, row.id),
              eq(features.workspaceId, scope!.workspaceId),
            ),
          ),
        doneStatusesIn(tx, scope!.workspaceId),
      ]);
      // Kept with `productId` for the roll-up below, which judges each child's
      // status against its own product's terminal stage; the shape the caller
      // sees drops it.
      const readableChildren = childRowsRaw.filter((child) =>
        canReadProductId(access, productById, child.productId),
      );
      const childRows = readableChildren.map(
        ({ productId: _productId, ...child }) => child,
      );

      // The whole workspace tree (id + parent), for the subtree walks below.
      const treeRows = await tx
        .select({
          id: features.id,
          parentId: features.parentId,
          productId: features.productId,
        })
        .from(features)
        .where(eq(features.workspaceId, scope!.workspaceId));
      const visibleTreeRows = treeRows.filter((r) =>
        canReadProductId(access, productById, r.productId),
      );
      const visibleIds = new Set(visibleTreeRows.map((r) => r.id));

      // GitHub links: this item's own + all descendants' (rolled up). Walk the
      // parent map down from `row.id` to collect the subtree feature ids.
      const childrenOf = new Map<string, string[]>();
      for (const r of visibleTreeRows) {
        if (!r.parentId || !visibleIds.has(r.parentId)) continue;
        (
          childrenOf.get(r.parentId) ??
          childrenOf.set(r.parentId, []).get(r.parentId)!
        ).push(r.id);
      }
      const subtree = new Set<string>([row.id]);
      const queue = [row.id];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const child of childrenOf.get(cur) ?? []) {
          if (!subtree.has(child)) {
            subtree.add(child);
            queue.push(child);
          }
        }
      }
      const ghRows = await tx
        .select({
          id: featureGithubLinks.id,
          featureId: featureGithubLinks.featureId,
          kind: featureGithubLinks.kind,
          number: featureGithubLinks.number,
          branch: featureGithubLinks.branch,
          url: featureGithubLinks.url,
          title: featureGithubLinks.title,
          state: featureGithubLinks.state,
          headBranch: featureGithubLinks.headBranch,
        })
        .from(featureGithubLinks)
        .where(
          and(
            eq(featureGithubLinks.workspaceId, scope!.workspaceId),
            inArray(featureGithubLinks.featureId, [...subtree]),
          ),
        );
      const sourceInfo = ghRows.length
        ? await tx
            .select({
              id: features.id,
              specId: features.specId,
              title: features.title,
            })
            .from(features)
            .where(
              and(
                eq(features.workspaceId, scope!.workspaceId),
                inArray(features.id, [
                  ...new Set(ghRows.map((l) => l.featureId)),
                ]),
              ),
            )
        : [];
      const sourceById = new Map(sourceInfo.map((s) => [s.id, s]));
      const githubLinks: GithubLink[] = ghRows.map((l) => ({
        id: l.id,
        kind: l.kind,
        number: l.number,
        branch: l.branch,
        url: l.url,
        title: l.title,
        state: l.state,
        headBranch: l.headBranch,
        sourceSpecId: sourceById.get(l.featureId)?.specId ?? row.specId,
        sourceTitle: sourceById.get(l.featureId)?.title ?? row.title,
        inherited: l.featureId !== row.id,
      }));
      const githubSummary = emptyAgg();
      for (const l of ghRows) tallyLink(githubSummary, l.kind, l.state);

      return {
        specId: row.specId,
        title: row.title,
        level: row.level,
        // See listFeatures: "no attached spec", not "no repo" (ADR 0003 D2).
        isDbNative: row.index == null,
        productId: row.productId,
        status: row.status,
        rank: row.rank,
        tags: row.tags,
        releaseId: row.releaseId,
        cycleId: row.cycleId,
        assigneeId: row.assigneeId,
        assigneeName,
        customFields: toCustomFields(row.customFields),
        ...riceFields({
          riceReach: row.riceReach,
          riceImpact: row.riceImpact,
          riceConfidence: row.riceConfidence,
          riceEffort: row.riceEffort,
        }),
        path: row.index?.path ?? "",
        content,
        blobSha: row.index?.blobSha ?? null,
        sections: extractSections(content),
        relations,
        blocksCount: relations.filter((r) => r.direction === "blocks").length,
        blockedByCount: relations.filter((r) => r.direction === "blocked_by")
          .length,
        parentSpecId,
        parentTitle,
        children: childRows,
        childCount: childRows.length,
        childDoneCount: readableChildren.filter((c) =>
          done.isDone(c.status, c.productId),
        ).length,
        githubSummary,
        githubLinks,
      };
    });
  }

  // ==========================================================================
  // Workspace configuration: levels, detail templates, properties,
  // statuses, and stage gates
  // ==========================================================================
  //
  // Implemented in ./workspace-config.ts. The bodies moved verbatim; these
  // delegate so that `DbStore` stays the one thing callers hold.

  listLevels(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]> {
    return configStore.listLevels(this, scope, productId);
  }

  updateLevels(
    updates: LevelUpdate[],
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    return configStore.updateLevels(this, updates, scope);
  }

  updateLevelFields(
    fields: Record<string, string[] | null>,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]> {
    return configStore.updateLevelFields(this, fields, scope, productId);
  }

  updateLevelTemplates(
    templates: Record<string, string | null>,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]> {
    return configStore.updateLevelTemplates(this, templates, scope, productId);
  }

  listDetailTemplates(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<DetailTemplate[]> {
    return configStore.listDetailTemplates(this, scope, productId);
  }

  createDetailTemplate(
    input: DetailTemplateInput,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<DetailTemplate> {
    return configStore.createDetailTemplate(this, input, scope, productId);
  }

  updateDetailTemplate(
    id: string,
    patch: DetailTemplatePatch,
    scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    return configStore.updateDetailTemplate(this, id, patch, scope);
  }

  deleteDetailTemplate(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return configStore.deleteDetailTemplate(this, id, scope);
  }

  listProperties(
    scope?: WorkspaceScope,
    entity?: PropertyEntity,
    productId?: string | null,
  ): Promise<PropertyDef[]> {
    return configStore.listProperties(this, scope, entity, productId);
  }

  listPropertiesUnion(
    scope: WorkspaceScope | undefined,
    productIds: string[] | null,
    entity?: PropertyEntity,
  ): Promise<PropertyDef[]> {
    return configStore.listPropertiesUnion(this, scope, productIds, entity);
  }

  listStatuses(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceStatus[]> {
    return configStore.listStatuses(this, scope, productId);
  }

  listStatusesUnion(
    scope: WorkspaceScope | undefined,
    productIds: string[] | null,
  ): Promise<WorkspaceStatus[]> {
    return configStore.listStatusesUnion(this, scope, productIds);
  }

  replaceStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceStatus[]> {
    return configStore.replaceStatuses(this, stages, scope, productId);
  }

  listStageGates(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<StageGate[]> {
    return configStore.listStageGates(this, scope, productId);
  }

  replaceStageGates(
    gates: StageGateInput[],
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<StageGate[]> {
    return configStore.replaceStageGates(this, gates, scope, productId);
  }

  listGateCompletions(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<string[]> {
    return configStore.listGateCompletions(this, specId, scope);
  }

  setGateCompletion(
    specId: string,
    gateId: string,
    completed: boolean,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return configStore.setGateCompletion(this, specId, gateId, completed, scope);
  }

  createProperty(
    input: PropertyInput,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<PropertyDef> {
    return configStore.createProperty(this, input, scope, productId);
  }

  updateProperty(
    id: string,
    patch: PropertyPatch,
    scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    return configStore.updateProperty(this, id, patch, scope);
  }

  deleteProperty(id: string, scope?: WorkspaceScope): Promise<void> {
    return configStore.deleteProperty(this, id, scope);
  }

  // `levelsIn` is a DbStoreContext member, so it stays a method on the
  // store and delegates like the rest of the domain.
  levelsIn(
    tx: Tx,
    workspaceId: string,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]> {
    return configStore.levelsIn(this, tx, workspaceId, productId);
  }

  // ==========================================================================
  // Items: write, relations, GitHub links, and the event ledger
  //
  // `listItemEvents` and `itemActivitySummary` sit inside this block, between
  // `addGithubLink` and `removeGithubLink`. They read the ledger the writes
  // above populate, so they are in the right domain but the wrong order.
  // ==========================================================================

  async createFeature(
    input: CreateFeatureInput,
    scope?: WorkspaceScope,
    emitType?: string,
  ): Promise<FeatureRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const levels = await this.levelsIn(tx, ws);
      const [access, productById] = await Promise.all([
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, ws),
      ]);

      const title = input.title.trim();
      if (!title) throw new FeatureError("Title is required.");
      if (!levels.some((l) => l.key === input.level))
        throw new FeatureError(`Unknown level: ${input.level}`);
      // Leaf-level items are creatable here: a spec is an attachment, not an
      // identity, so a work item with no spec is a first-class row. See ADR 0003.

      // Resolve + validate the parent (must be exactly one level up).
      let parentId: string | null = null;
      if (input.parentSpecId) {
        const parent = await tx
          .select({
            id: features.id,
            level: features.level,
            productId: features.productId,
          })
          .from(features)
          .where(
            and(
              eq(features.specId, input.parentSpecId),
              eq(features.workspaceId, ws),
            ),
          );
        if (!parent[0])
          throw new FeatureError(`Unknown parent: ${input.parentSpecId}`);
        if (!canReadProductId(access, productById, parent[0].productId)) {
          throw new FeatureError(`Unknown parent: ${input.parentSpecId}`);
        }
        if (!isValidParentLevel(input.level, parent[0].level, levels))
          throw new FeatureError(
            `A ${input.level} can't sit under a ${parent[0].level}.`,
          );
        parentId = parent[0].id;
      } else if (!isValidParentLevel(input.level, null, levels)) {
        throw new FeatureError(`A ${input.level} requires a parent.`);
      }

      // Owning product: the requested one (must belong to this workspace), else
      // the workspace's default product.
      const productId = input.productId
        ? await this.requireProductId(tx, ws, input.productId)
        : await this.defaultProductId(tx, ws);
      if (!canWriteProductId(access, productId)) {
        throw new FeatureError(
          "Your role does not permit editing this product.",
        );
      }
      if (input.assigneeId)
        await this.assertWorkspaceMember(tx, ws, input.assigneeId);

      // A release assignment must point at a release in this workspace that is
      // either a portfolio release (no product) or one scoped to the new item's
      // own product. Mirrors the rule in updateFeature.
      if (input.releaseId) {
        const release = await tx
          .select({ id: releases.id, productId: releases.productId })
          .from(releases)
          .where(and(eq(releases.id, input.releaseId), eq(releases.workspaceId, ws)))
          .limit(1);
        if (!release[0]) {
          throw new FeatureError(`Unknown release: ${input.releaseId}`);
        }
        if (release[0].productId !== null && release[0].productId !== productId) {
          throw new FeatureError("Release belongs to a different product.");
        }
      }

      // Cycles follow the same rule on their own axis: a workspace-wide cycle
      // takes anything, a product cycle only that product's work.
      if (input.cycleId) {
        const cycle = await tx
          .select({ id: cycles.id, productId: cycles.productId })
          .from(cycles)
          .where(and(eq(cycles.id, input.cycleId), eq(cycles.workspaceId, ws)))
          .limit(1);
        if (!cycle[0]) {
          throw new FeatureError(`Unknown cycle: ${input.cycleId}`);
        }
        if (cycle[0].productId !== null && cycle[0].productId !== productId) {
          throw new FeatureError("Cycle belongs to a different product.");
        }
      }

      // An item created here has no spec attached, so it has no repo and no
      // frontmatter id; spec_id mirrors the row id, keeping every row uniformly
      // routable by specId. Attaching a spec later reuses this id (ADR 0003 D3).
      const id = randomUUID();
      const [row] = await tx
        .insert(features)
        .values({
          id,
          workspaceId: ws,
          repoId: null,
          productId,
          specId: id,
          level: input.level,
          title,
          status: input.status ?? "backlog",
          assigneeId: input.assigneeId ?? null,
          releaseId: input.releaseId ?? null,
          cycleId: input.cycleId ?? null,
          customFields: input.customFields ?? {},
          tags: input.tags ?? [],
          details: input.details?.trim() ? input.details : null,
          parentId,
          // A DB-native card's parent is user-chosen (sync never touches these
          // rows, but keep the discriminator honest). Null when it has none.
          parentSetBy: parentId ? "user" : null,
        })
        .returning();
      if (!row) throw new FeatureError("Failed to create work item.");

      // Record the creation event in the same transaction. `specId` is generated
      // here, so the store builds the payload (the caller can't know it yet).
      if (emitType) {
        await this.writeOutbox(tx, scope!, {
          type: emitType,
          productId: row.productId,
          data: {
            specId: row.specId,
            title: row.title,
            level: row.level,
            status: row.status,
          },
        });
      }

      return {
        specId: row.specId,
        title: row.title,
        level: row.level,
        isDbNative: true,
        productId: row.productId,
        status: row.status,
        rank: row.rank,
        tags: row.tags,
        releaseId: row.releaseId,
        cycleId: row.cycleId,
        assigneeId: row.assigneeId,
        customFields: toCustomFields(row.customFields),
        ...riceFields({
          riceReach: row.riceReach,
          riceImpact: row.riceImpact,
          riceConfidence: row.riceConfidence,
          riceEffort: row.riceEffort,
        }),
        path: "",
        blocksCount: 0,
        blockedByCount: 0,
        parentSpecId: input.parentSpecId ?? null,
        childCount: 0,
        childDoneCount: 0,
        githubSummary: emptyAgg(),
      } satisfies FeatureRecord;
    });
  }

  async deleteFeature(
    specId: string,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
    opts?: DeleteFeatureOptions,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const row = await tx
        .select({
          id: features.id,
          productId: features.productId,
          specPath: specIndex.path,
        })
        .from(features)
        .leftJoin(specIndex, eq(specIndex.featureId, features.id))
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
      if (!row[0]) throw new FeatureError(`Unknown work item: ${specId}`);
      const access = await this.accessIn(tx, scope!);
      if (!canWriteProductId(access, row[0].productId)) {
        throw new FeatureError(
          "Your role does not permit editing this product.",
        );
      }
      // An item with a spec attached can be deleted, but only together with its
      // git file: leaving the file behind would let the next sync re-import the
      // spec and recreate the item with default metadata, silently undoing the
      // delete. The caller removes the file first and passes `specRemoved`
      // (ADR 0003 D4). `spec_index` is ON DELETE CASCADE, so the index row goes
      // with the item either way.
      if (row[0].specPath !== null && !opts?.specRemoved) {
        throw new FeatureError(
          "This work item has a spec attached. Deleting it also deletes " +
            `${row[0].specPath} from git; pass removeSpec to confirm.`,
        );
      }
      // Children's parent_id is ON DELETE SET NULL, so they're orphaned, not deleted.
      await tx
        .delete(features)
        .where(and(eq(features.id, row[0].id), eq(features.workspaceId, ws)));
      if (emit) await this.writeOutbox(tx, scope!, emit);
    });
  }

  /**
   * See FeatureStore.pruneAutoGrouping. Every check runs inside one scoped
   * transaction, so a concurrent write cannot slip a child (or a comment, or a
   * relation) onto the grouping between the checks and the delete.
   */
  async pruneAutoGrouping(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<boolean> {
    if (!scope) return false;
    return this.scoped(scope, async (tx) => {
      const ws = scope.workspaceId;
      const [row] = await tx
        .select({
          id: features.id,
          productId: features.productId,
          repoId: features.repoId,
          externalKey: features.externalKey,
          title: features.title,
          status: features.status,
          tags: features.tags,
          customFields: features.customFields,
          releaseId: features.releaseId,
          assigneeId: features.assigneeId,
          details: features.details,
          rank: features.rank,
          riceReach: features.riceReach,
          riceImpact: features.riceImpact,
          riceConfidence: features.riceConfidence,
          riceEffort: features.riceEffort,
        })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));

      // Only a sync-created grouping is ever a candidate: a spec-backed row has
      // a repoId, and a card a person made by hand has no externalKey.
      if (!row || row.repoId !== null || row.externalKey === null) return false;
      const access = await this.accessIn(tx, scope);
      if (!canWriteProductId(access, row.productId)) return false;

      // Anything a person could have set means they adopted the grouping, so it
      // stops being litter and we leave it alone.
      const untouched =
        isGeneratedGroupingTitle(row.externalKey, row.title) &&
        row.status === SYNC_CREATED_STATUS &&
        row.releaseId === null &&
        row.assigneeId === null &&
        row.details === null &&
        row.rank === null &&
        row.riceReach === null &&
        row.riceImpact === null &&
        row.riceConfidence === null &&
        row.riceEffort === null &&
        (row.tags?.length ?? 0) === 0 &&
        Object.keys(row.customFields ?? {}).length === 0;
      if (!untouched) return false;

      // Referenced by anything at all: keep it. Children first, since a sibling
      // spec still living here is the common reason to stop.
      const [child] = await tx
        .select({ id: features.id })
        .from(features)
        .where(and(eq(features.parentId, row.id), eq(features.workspaceId, ws)))
        .limit(1);
      if (child) return false;

      const [relation] = await tx
        .select({ id: featureLinks.id })
        .from(featureLinks)
        .where(
          or(
            eq(featureLinks.fromFeatureId, row.id),
            eq(featureLinks.toFeatureId, row.id),
          ),
        )
        .limit(1);
      if (relation) return false;

      const [ghLink] = await tx
        .select({ id: featureGithubLinks.id })
        .from(featureGithubLinks)
        .where(eq(featureGithubLinks.featureId, row.id))
        .limit(1);
      if (ghLink) return false;

      const [comment] = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.featureId, row.id))
        .limit(1);
      if (comment) return false;

      await tx
        .delete(features)
        .where(and(eq(features.id, row.id), eq(features.workspaceId, ws)));
      return true;
    });
  }

  async updateFeature(
    specId: string,
    patch: FeaturePatch,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
  ): Promise<void> {
    // `parentSpecId` isn't a column, so translate it to the parent row's `parentId`.
    const { parentSpecId, ...rest } = patch;
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      // Reads the fields the ledger tracks, not just the one authorization
      // needs: a change's previous value is knowable only here, before the
      // update overwrites it, and no later feature can reconstruct it.
      const current = await tx
        .select({
          id: features.id,
          productId: features.productId,
          title: features.title,
          status: features.status,
          tags: features.tags,
          releaseId: features.releaseId,
          cycleId: features.cycleId,
          assigneeId: features.assigneeId,
          customFields: features.customFields,
          details: features.details,
          parentId: features.parentId,
          riceReach: features.riceReach,
          riceImpact: features.riceImpact,
          riceConfidence: features.riceConfidence,
          riceEffort: features.riceEffort,
        })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)))
        .limit(1);
      if (!current[0]) throw new RelationError(`Unknown feature: ${specId}`);
      const [access, productById] = await Promise.all([
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, ws),
      ]);
      if (!canWriteProductId(access, current[0].productId)) {
        throw new RelationError(
          "Your role does not permit editing this product.",
        );
      }
      if (typeof rest.assigneeId === "string" && rest.assigneeId) {
        await this.assertWorkspaceMember(tx, ws, rest.assigneeId);
      }
      // A release assignment must point at a release in this workspace that is
      // either a portfolio release (no product) or one scoped to this item's
      // own product. Items can't be scheduled into another product's release.
      if (typeof rest.releaseId === "string" && rest.releaseId) {
        const release = await tx
          .select({ id: releases.id, productId: releases.productId })
          .from(releases)
          .where(
            and(eq(releases.id, rest.releaseId), eq(releases.workspaceId, ws)),
          )
          .limit(1);
        if (!release[0]) {
          throw new RelationError(`Unknown release: ${rest.releaseId}`);
        }
        if (
          release[0].productId !== null &&
          release[0].productId !== current[0].productId
        ) {
          throw new RelationError(
            "Release belongs to a different product.",
          );
        }
      }
      // Same rule for the cycle axis; the two are independent, so setting one
      // never validates or clears the other.
      if (typeof rest.cycleId === "string" && rest.cycleId) {
        const cycle = await tx
          .select({ id: cycles.id, productId: cycles.productId })
          .from(cycles)
          .where(and(eq(cycles.id, rest.cycleId), eq(cycles.workspaceId, ws)))
          .limit(1);
        if (!cycle[0]) {
          throw new RelationError(`Unknown cycle: ${rest.cycleId}`);
        }
        if (
          cycle[0].productId !== null &&
          cycle[0].productId !== current[0].productId
        ) {
          throw new RelationError("Cycle belongs to a different product.");
        }
      }
      const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
      if (parentSpecId !== undefined) {
        // Record that a person set this parent, so a later `feature:` frontmatter
        // change on re-sync leaves it alone (gh-51). Covers detaching to the
        // Unassigned view too: an unparented item stays unassigned.
        set.parentSetBy = "user";
        if (parentSpecId === null) {
          set.parentId = null;
        } else {
          const parent = await tx
            .select({ id: features.id, productId: features.productId })
            .from(features)
            .where(
              and(
                eq(features.specId, parentSpecId),
                eq(features.workspaceId, scope!.workspaceId),
              ),
            );
          if (!parent[0])
            throw new RelationError(`Unknown parent feature: ${parentSpecId}`);
          if (!canReadProductId(access, productById, parent[0].productId)) {
            throw new RelationError(`Unknown parent feature: ${parentSpecId}`);
          }
          set.parentId = parent[0].id;
        }
      }
      // Computed before the update, against the values it is about to replace.
      const changes = ledgerChanges(current[0], set);
      await tx
        .update(features)
        .set(set)
        .where(
          and(
            eq(features.specId, specId),
            eq(features.workspaceId, scope!.workspaceId),
          ),
        );
      // The title recorded on the row is the one the item had when it changed,
      // including on the write that renames it, so the history reads as what
      // the item was called at the time rather than what it is called now.
      await this.writeItemEvents(
        tx,
        scope!,
        {
          featureId: current[0].id,
          specId,
          title: current[0].title,
          productId: current[0].productId,
        },
        changes,
      );
      if (emit) await this.writeOutbox(tx, scope!, emit);
    });
  }

  async addRelation(
    specId: string,
    input: RelationInput,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const ids = await tx
        .select({
          id: features.id,
          specId: features.specId,
          productId: features.productId,
        })
        .from(features)
        .where(
          and(
            eq(features.workspaceId, ws),
            inArray(features.specId, [specId, input.toSpecId]),
          ),
        );
      const self = ids.find((f) => f.specId === specId);
      const other = ids.find((f) => f.specId === input.toSpecId);
      if (!self) throw new RelationError(`Unknown feature: ${specId}`);
      if (!other)
        throw new RelationError(`Unknown related feature: ${input.toSpecId}`);
      if (self.id === other.id)
        throw new RelationError("A feature cannot relate to itself.");
      const [access, productById] = await Promise.all([
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, ws),
      ]);
      if (!canWriteProductId(access, self.productId)) {
        throw new RelationError(
          "Your role does not permit editing this product.",
        );
      }
      if (!canReadProductId(access, productById, other.productId)) {
        throw new RelationError(`Unknown related feature: ${input.toSpecId}`);
      }

      // Resolve the requested direction into a canonical stored edge.
      const edge = toEdge(self.id, other.id, input.direction);

      // Reject a contradictory cycle (A blocks B while B blocks A).
      if (edge.type === "blocks") {
        const reverse = await tx
          .select({ id: featureLinks.id })
          .from(featureLinks)
          .where(
            and(
              eq(featureLinks.workspaceId, ws),
              eq(featureLinks.type, "blocks"),
              eq(featureLinks.fromFeatureId, edge.toFeatureId),
              eq(featureLinks.toFeatureId, edge.fromFeatureId),
            ),
          );
        if (reverse.length)
          throw new RelationError(
            "That would create a circular blocking dependency.",
          );
      }

      // Treat `relates_to` as symmetric: skip if the inverse edge exists.
      if (edge.type === "relates_to") {
        const existing = await tx
          .select({ id: featureLinks.id })
          .from(featureLinks)
          .where(
            and(
              eq(featureLinks.workspaceId, ws),
              eq(featureLinks.type, "relates_to"),
              eq(featureLinks.fromFeatureId, edge.toFeatureId),
              eq(featureLinks.toFeatureId, edge.fromFeatureId),
            ),
          );
        if (existing.length) return;
      }

      await tx
        .insert(featureLinks)
        .values({ workspaceId: ws, ...edge })
        .onConflictDoNothing();
    });
  }

  async removeRelation(
    specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const link = await tx.query.featureLinks.findFirst({
        where: and(
          eq(featureLinks.id, linkId),
          eq(featureLinks.workspaceId, ws),
        ),
      });
      if (!link) return;
      const endpoints = await tx
        .select({
          id: features.id,
          specId: features.specId,
          productId: features.productId,
        })
        .from(features)
        .where(
          and(
            eq(features.workspaceId, ws),
            inArray(features.id, [link.fromFeatureId, link.toFeatureId]),
          ),
        );
      const self = endpoints.find((feature) => feature.specId === specId);
      if (!self) throw new RelationError(`Unknown relation: ${linkId}`);
      const access = await this.accessIn(tx, scope!);
      if (!canWriteProductId(access, self.productId)) {
        throw new RelationError(
          "Your role does not permit editing this product.",
        );
      }
      await tx
        .delete(featureLinks)
        .where(
          and(
            eq(featureLinks.id, linkId),
            eq(featureLinks.workspaceId, scope!.workspaceId),
          ),
        );
    });
  }

  async addGithubLink(
    specId: string,
    link: ResolvedGithubLink,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const feat = await tx
        .select({ id: features.id, productId: features.productId })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
      if (!feat[0]) throw new RelationError(`Unknown feature: ${specId}`);
      const access = await this.accessIn(tx, scope!);
      if (!canWriteProductId(access, feat[0].productId)) {
        throw new RelationError(
          "Your role does not permit editing this product.",
        );
      }
      const repo = await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.id, link.repoId),
            eq(repositories.workspaceId, ws),
          ),
        )
        .limit(1);
      if (!repo[0])
        throw new RelationError("Unknown repository for GitHub link.");
      await tx
        .insert(featureGithubLinks)
        .values({
          workspaceId: ws,
          featureId: feat[0].id,
          repoId: link.repoId,
          kind: link.kind,
          number: link.number,
          branch: link.branch,
          url: link.url,
          title: link.title,
          state: link.state,
          headBranch: link.headBranch ?? null,
          authorId: link.authorId ?? null,
        })
        // Re-linking the same url refreshes the cached title/state.
        .onConflictDoUpdate({
          target: [featureGithubLinks.featureId, featureGithubLinks.url],
          set: {
            title: link.title,
            state: link.state,
            // Only ever set, never cleared. Someone hand-linking the url of a
            // pull request the write path opened would otherwise demote a
            // pending change to an ordinary link, and the author would be told
            // their change is no longer waiting for review when it still is.
            ...(link.headBranch ? { headBranch: link.headBranch } : {}),
            // Same rule for the author: a second edit joining an open proposal
            // must not reassign whose change it is to whoever touched it last.
            ...(link.authorId ? { authorId: link.authorId } : {}),
          },
        });
    });
  }

  /**
   * One item's change history, newest first.
   *
   * Joins through `features` rather than trusting the caller's spec id against
   * the snapshotted `spec_id` column: the ledger keeps history for deleted
   * items, and matching on the snapshot alone would let a caller read the
   * history of an item they can no longer see.
   */
  async listItemEvents(
    specId: string,
    scope?: WorkspaceScope,
    limit = 100,
  ): Promise<ItemEvent[]> {
    if (!scope) return [];
    return this.scoped(scope, async (tx) => {
      const ws = scope.workspaceId;
      const feature = await tx
        .select({ id: features.id, productId: features.productId })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)))
        .limit(1);
      if (!feature[0]) return [];
      const access = await this.accessIn(tx, scope);
      const productById = await this.productVisibilityIn(tx, ws);
      if (!canReadProductId(access, productById, feature[0].productId)) return [];

      const rows = await tx
        .select({
          id: itemEvents.id,
          type: itemEvents.type,
          field: itemEvents.field,
          before: itemEvents.before,
          after: itemEvents.after,
          actorType: itemEvents.actorType,
          actorId: itemEvents.actorId,
          actorLabel: itemEvents.actorLabel,
          createdAt: itemEvents.createdAt,
        })
        .from(itemEvents)
        .where(
          and(
            eq(itemEvents.workspaceId, ws),
            eq(itemEvents.featureId, feature[0].id),
          ),
        )
        .orderBy(desc(itemEvents.createdAt))
        .limit(limit);

      return rows.map((r) => ({
        ...r,
        actorType: r.actorType as ActorType,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  /**
   * Cross-item activity report over the change ledger.
   *
   * Aggregated in Postgres rather than by reading rows into memory: this is the
   * one caller whose result set grows without bound as a workspace is used, and
   * a report that works for a month and dies at a year is not a report.
   *
   * Product visibility is applied by joining `features`, so a private product's
   * changes never reach someone who cannot see the items. That also means an
   * event whose item has since been deleted is not counted here, which is the
   * right trade for a report: the row is kept for audit, but there is no item
   * left to check anyone's access against.
   */
  async itemActivitySummary(
    query: ActivityQuery,
    scope?: WorkspaceScope,
  ): Promise<ActivitySummary> {
    const empty: ActivitySummary = {
      since: null,
      total: 0,
      byActor: [],
      byField: [],
      byDay: [],
      stageTime: [],
    };
    if (!scope) return empty;

    return this.scoped(scope, async (tx) => {
      const ws = scope.workspaceId;
      const access = await this.accessIn(tx, scope);
      const productById = await this.productVisibilityIn(tx, ws);
      const readable = [...productById.values()]
        .filter((p) => canReadProduct(access, p))
        .map((p) => p.id);
      // Intersected with what the caller can read, never substituted for it:
      // asking for a product you cannot see must narrow the report, not widen
      // it.
      // An empty list is a request for nothing, not a request for everything:
      // a product group with no products must report zero rather than inherit
      // the workspace's numbers.
      const requested = query.productIds;
      const scoped =
        requested != null ? readable.filter((id) => requested.includes(id)) : readable;

      // Each id is bound as a parameter rather than pasted into the string.
      // They are database-issued uuids today, so interpolation would be safe
      // and would still be a template waiting to be copied somewhere it is not.
      // An empty list is handled separately: `in ()` is a syntax error.
      const productFilter =
        scoped.length > 0
          ? sql`and (e.product_id is null or e.product_id in (${sql.join(
              scoped.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}))`
          : sql`and e.product_id is null`;

      const window = sql`
        e.workspace_id = ${ws}
        and e.created_at >= ${query.from}
        and e.created_at < ${query.to}
        ${productFilter}
      `;

      const [sinceRow] = (await tx.execute(sql`
        select min(created_at) as since from item_events where workspace_id = ${ws}
      `)) as unknown as { since: Date | string | null }[];

      const byActor = (await tx.execute(sql`
        select e.actor_type, e.actor_id, e.actor_label, count(*)::int as count
        from item_events e
        where ${window}
        group by e.actor_type, e.actor_id, e.actor_label
        order by count desc
        limit 50
      `)) as unknown as {
        actor_type: string;
        actor_id: string | null;
        actor_label: string | null;
        count: number;
      }[];

      const byField = (await tx.execute(sql`
        select e.type, e.field, count(*)::int as count
        from item_events e
        where ${window}
        group by e.type, e.field
        order by count desc
      `)) as unknown as { type: string; field: string | null; count: number }[];

      const byDay = (await tx.execute(sql`
        select to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD') as day,
               count(*)::int as count
        from item_events e
        where ${window}
        group by day
        order by day
      `)) as unknown as { day: string; count: number }[];

      // Time in a stage is the gap between two consecutive status changes on
      // the same item, so the span belongs to the status being left. The first
      // recorded change for an item has no predecessor and is skipped: we do
      // not know when it entered that stage, and assuming the item's creation
      // date would invent data for anything that existed before the ledger did.
      const stageTime = (await tx.execute(sql`
        with spans as (
          select e.before #>> '{}' as status,
                 e.created_at - lag(e.created_at) over (
                   partition by e.feature_id order by e.created_at
                 ) as elapsed
          from item_events e
          where ${window} and e.field = 'status'
        )
        select status,
               round(avg(extract(epoch from elapsed)) / 3600.0, 2)::float8 as average_hours,
               count(*)::int as samples
        from spans
        where elapsed is not null and status is not null
        group by status
        order by samples desc
      `)) as unknown as {
        status: string;
        average_hours: number;
        samples: number;
      }[];

      const since = sinceRow?.since ?? null;
      return {
        since: since ? new Date(since).toISOString() : null,
        total: byField.reduce((sum, r) => sum + Number(r.count), 0),
        byActor: byActor.map((r) => ({
          actorType: r.actor_type as ActorType,
          actorId: r.actor_id,
          actorLabel: r.actor_label,
          count: Number(r.count),
        })),
        byField: byField.map((r) => ({
          type: r.type,
          field: r.field,
          count: Number(r.count),
        })),
        byDay: byDay.map((r) => ({ day: r.day, count: Number(r.count) })),
        stageTime: stageTime.map((r) => ({
          status: r.status,
          averageHours: Number(r.average_hours),
          samples: Number(r.samples),
        })),
      };
    });
  }

  async removeGithubLink(
    specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const rows = await tx
        .select({
          featureId: featureGithubLinks.featureId,
          specId: features.specId,
          productId: features.productId,
        })
        .from(featureGithubLinks)
        .innerJoin(features, eq(features.id, featureGithubLinks.featureId))
        .where(
          and(
            eq(featureGithubLinks.id, linkId),
            eq(featureGithubLinks.workspaceId, ws),
            eq(features.workspaceId, ws),
          ),
        )
        .limit(1);
      if (!rows[0]) return;
      if (rows[0].specId !== specId) {
        throw new RelationError(`Unknown GitHub link: ${linkId}`);
      }
      const access = await this.accessIn(tx, scope!);
      if (!canWriteProductId(access, rows[0].productId)) {
        throw new RelationError(
          "Your role does not permit editing this product.",
        );
      }
      await tx
        .delete(featureGithubLinks)
        .where(
          and(
            eq(featureGithubLinks.id, linkId),
            eq(featureGithubLinks.workspaceId, scope!.workspaceId),
          ),
        );
    });
  }

  // ==========================================================================
  // Saved views and board preferences
  // ==========================================================================
  //
  // Implemented in ./views.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

  listSavedViews(scope?: WorkspaceScope): Promise<SavedView[]> {
    return viewStore.listSavedViews(this, scope);
  }

  createSavedView(
    input: SavedViewInput,
    scope?: WorkspaceScope,
  ): Promise<SavedView> {
    return viewStore.createSavedView(this, input, scope);
  }

  updateSavedView(
    id: string,
    patch: SavedViewPatch,
    scope?: WorkspaceScope,
  ): Promise<SavedView | null> {
    return viewStore.updateSavedView(this, id, patch, scope);
  }

  deleteSavedView(id: string, scope?: WorkspaceScope): Promise<void> {
    return viewStore.deleteSavedView(this, id, scope);
  }

  getBoardPreferences(
    scope?: WorkspaceScope,
    board?: BoardKey,
  ): Promise<BoardPreferences | null> {
    return viewStore.getBoardPreferences(this, scope, board);
  }

  setBoardPreferences(
    prefs: BoardPreferences,
    scope?: WorkspaceScope,
    board?: BoardKey,
  ): Promise<void> {
    return viewStore.setBoardPreferences(this, prefs, scope, board);
  }

  // ── Custom properties ─────────────────────────────────────────────────

  // ── Releases ──────────────────────────────────────────────────────────

  // ==========================================================================
  // Releases
  // ==========================================================================
  //
  // Implemented in ./releases.ts. The bodies moved verbatim; these delegate
  // so that `DbStore` stays the one thing callers hold.

  listReleases(scope?: WorkspaceScope): Promise<ReleaseRecord[]> {
    return releaseStore.listReleases(this, scope);
  }

  createRelease(
    input: ReleaseInput,
    scope?: WorkspaceScope,
  ): Promise<ReleaseRecord> {
    return releaseStore.createRelease(this, input, scope);
  }

  updateRelease(
    id: string,
    patch: ReleasePatch,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
  ): Promise<ReleaseRecord> {
    return releaseStore.updateRelease(this, id, patch, scope, emit);
  }

  deleteRelease(id: string, scope?: WorkspaceScope): Promise<void> {
    return releaseStore.deleteRelease(this, id, scope);
  }

  // ==========================================================================
  // Cycles
  // ==========================================================================
  //
  // Implemented in ./cycles.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

  listCycles(scope?: WorkspaceScope): Promise<CycleRecord[]> {
    return cycleStore.listCycles(this, scope);
  }

  createCycle(input: CycleInput, scope?: WorkspaceScope): Promise<CycleRecord> {
    return cycleStore.createCycle(this, input, scope);
  }

  generateCycles(
    input: CycleGenerateInput,
    scope?: WorkspaceScope,
  ): Promise<CycleRecord[]> {
    return cycleStore.generateCycles(this, input, scope);
  }

  updateCycle(
    id: string,
    patch: CyclePatch,
    scope?: WorkspaceScope,
  ): Promise<CycleRecord> {
    return cycleStore.updateCycle(this, id, patch, scope);
  }

  deleteCycle(id: string, scope?: WorkspaceScope): Promise<void> {
    return cycleStore.deleteCycle(this, id, scope);
  }

  rolloverCycle(
    fromId: string,
    toId: string,
    scope?: WorkspaceScope,
  ): Promise<CycleRolloverResult> {
    return cycleStore.rolloverCycle(this, fromId, toId, scope);
  }

  // ==========================================================================
  // Goals and key results
  // ==========================================================================
  //
  // Implemented in ./goals.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

  listGoals(scope?: WorkspaceScope): Promise<GoalRecord[]> {
    return goalStore.listGoals(this, scope);
  }

  createGoal(
    input: GoalInput,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    return goalStore.createGoal(this, input, scope);
  }

  updateGoal(
    id: string,
    patch: GoalPatch,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    return goalStore.updateGoal(this, id, patch, scope);
  }

  deleteGoal(id: string, scope?: WorkspaceScope): Promise<void> {
    return goalStore.deleteGoal(this, id, scope);
  }

  createKeyResult(
    goalId: string,
    input: KeyResultInput,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    return goalStore.createKeyResult(this, goalId, input, scope);
  }

  updateKeyResult(
    id: string,
    patch: KeyResultPatch,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    return goalStore.updateKeyResult(this, id, patch, scope);
  }

  deleteKeyResult(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    return goalStore.deleteKeyResult(this, id, scope);
  }

  listGoalContributions(
    goalId: string,
    scope?: WorkspaceScope,
  ): Promise<GoalContribution[]> {
    return goalStore.listGoalContributions(this, goalId, scope);
  }

  listGoalLinks(scope?: WorkspaceScope): Promise<GoalLinkRef[]> {
    return goalStore.listGoalLinks(this, scope);
  }

  listItemGoals(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<ItemGoalRef[]> {
    return goalStore.listItemGoals(this, specId, scope);
  }

  linkGoal(
    goalId: string,
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return goalStore.linkGoal(this, goalId, specId, scope);
  }

  unlinkGoal(
    goalId: string,
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return goalStore.unlinkGoal(this, goalId, specId, scope);
  }

  // ── Comments ──────────────────────────────────────────────────────────

  // ==========================================================================
  // Comments
  // ==========================================================================
  //
  // Implemented in ./collaboration.ts. The bodies moved verbatim; these
  // delegate so that `DbStore` stays the one thing callers hold.

  listComments(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<CommentRecord[]> {
    return collabStore.listComments(this, specId, scope);
  }

  createComment(
    specId: string,
    input: CommentInput,
    scope?: WorkspaceScope,
  ): Promise<CommentRecord> {
    return collabStore.createComment(this, specId, input, scope);
  }

  deleteComment(commentId: string, scope?: WorkspaceScope): Promise<void> {
    return collabStore.deleteComment(this, commentId, scope);
  }

  // ── Notifications ─────────────────────────────────────────────────────

  // ==========================================================================
  // Notifications
  // ==========================================================================

  listNotifications(scope?: WorkspaceScope): Promise<NotificationList> {
    return collabStore.listNotifications(this, scope);
  }

  markNotificationRead(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return collabStore.markNotificationRead(this, id, scope);
  }

  markAllNotificationsRead(scope?: WorkspaceScope): Promise<void> {
    return collabStore.markAllNotificationsRead(this, scope);
  }

  // ── Ideas ─────────────────────────────────────────────────────────────

  // ==========================================================================
  // Ideas
  // ==========================================================================
  //
  // Implemented in ./ideas.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

  listIdeas(scope?: WorkspaceScope): Promise<IdeaRecord[]> {
    return ideaStore.listIdeas(this, scope);
  }

  createIdea(
    input: IdeaInput,
    scope?: WorkspaceScope,
  ): Promise<IdeaRecord> {
    return ideaStore.createIdea(this, input, scope);
  }

  updateIdea(
    id: string,
    patch: IdeaPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaRecord> {
    return ideaStore.updateIdea(this, id, patch, scope);
  }

  deleteIdea(id: string, scope?: WorkspaceScope): Promise<void> {
    return ideaStore.deleteIdea(this, id, scope);
  }

  voteIdea(id: string, scope?: WorkspaceScope): Promise<IdeaRecord> {
    return ideaStore.voteIdea(this, id, scope);
  }

  unvoteIdea(id: string, scope?: WorkspaceScope): Promise<IdeaRecord> {
    return ideaStore.unvoteIdea(this, id, scope);
  }

  promoteIdea(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
    return ideaStore.promoteIdea(this, id, scope);
  }

  listIdeaStatuses(scope?: WorkspaceScope): Promise<IdeaStage[]> {
    return ideaStore.listIdeaStatuses(this, scope);
  }

  replaceIdeaStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
  ): Promise<IdeaStage[]> {
    return ideaStore.replaceIdeaStatuses(this, stages, scope);
  }

  // ==========================================================================
  // Transition mode and per-product card configuration
  // ==========================================================================
  //
  // Implemented in ./settings.ts. The bodies moved verbatim; these delegate
  // so that `DbStore` stays the one thing callers hold.

  getTransitionMode(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<TransitionMode> {
    return settingsStore.getTransitionMode(this, scope, productId);
  }

  setTransitionMode(
    mode: TransitionMode | null,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<TransitionMode> {
    return settingsStore.setTransitionMode(this, mode, scope, productId);
  }

  cardsOverrides(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<CardsOverrides> {
    return settingsStore.cardsOverrides(this, scope, productId);
  }

  listTransitionModes(
    scope?: WorkspaceScope,
  ): Promise<TransitionModeSettings> {
    return settingsStore.listTransitionModes(this, scope);
  }

  // ==========================================================================
  // Idea settings
  // ==========================================================================
  //
  // Implemented in ./ideas.ts, alongside the ideas they configure.

  getIdeaSettings(scope?: WorkspaceScope): Promise<IdeaSettings> {
    return ideaStore.getIdeaSettings(this, scope);
  }

  updateIdeaSettings(
    patch: IdeaSettingsPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaSettings> {
    return ideaStore.updateIdeaSettings(this, patch, scope);
  }

  // ── Docs (Plan-section areas) ───────────────────────────────────────────

  // ==========================================================================
  // Doc spaces and pages
  // ==========================================================================
  //
  // Implemented in ./docs.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

  getDocSpace(
    productId: string,
    area: DocArea,
    scope?: WorkspaceScope,
  ): Promise<DocSpace> {
    return docStore.getDocSpace(this, productId, area, scope);
  }

  setDocSpace(
    productId: string,
    area: DocArea,
    input: DocSpaceInput,
    scope?: WorkspaceScope,
  ): Promise<DocSpace> {
    return docStore.setDocSpace(this, productId, area, input, scope);
  }

  listDocPages(
    productId: string,
    area: DocArea,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord[]> {
    return docStore.listDocPages(this, productId, area, scope);
  }

  createDocPage(
    input: DocPageInput,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord> {
    return docStore.createDocPage(this, input, scope);
  }

  updateDocPage(
    id: string,
    patch: DocPagePatch,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord> {
    return docStore.updateDocPage(this, id, patch, scope);
  }

  deleteDocPage(id: string, scope?: WorkspaceScope): Promise<void> {
    return docStore.deleteDocPage(this, id, scope);
  }

  // ── Products ────────────────────────────────────────────────────────────

  /** The workspace's default product id, creating it if it's somehow missing. */
  async defaultProductId(tx: Tx, ws: string): Promise<string> {
    const existing = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.workspaceId, ws),
          eq(products.key, DEFAULT_PRODUCT_KEY),
        ),
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
        and(
          eq(products.workspaceId, ws),
          eq(products.key, DEFAULT_PRODUCT_KEY),
        ),
      )
      .limit(1);
    if (!row[0])
      throw new ProductError("Could not resolve the default product.");
    return row[0].id;
  }

  /** Verify a product id belongs to the workspace, returning it. */
  async requireProductId(
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

  // ==========================================================================
  // Products, product groups, members, and roll-up summaries
  // ==========================================================================

  async getProductAccess(scope?: WorkspaceScope): Promise<ProductAccess> {
    return this.scoped(scope, (tx) => this.accessIn(tx, scope!));
  }

  /**
   * Assert `userId` is a member of `ws`. Guards fields that reference a user by
   * id (assignee, product-member target) so a caller can't point them at an
   * arbitrary global user id (e.g. someone in another workspace).
   */
  private async assertWorkspaceMember(
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
  async accessIn(
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
  async productVisibilityIn(
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
  private async itemCounts(tx: Tx, ws: string): Promise<Map<string, number>> {
    const rows = await tx
      .select({ productId: features.productId, n: count() })
      .from(features)
      .where(eq(features.workspaceId, ws))
      .groupBy(features.productId);
    const out = new Map<string, number>();
    for (const r of rows) if (r.productId) out.set(r.productId, Number(r.n));
    return out;
  }

  async listProducts(scope?: WorkspaceScope): Promise<ProductRecord[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [rows, counts, access] = await Promise.all([
        tx
          .select()
          .from(products)
          .where(eq(products.workspaceId, ws))
          .orderBy(asc(products.position), asc(products.name)),
        this.itemCounts(tx, ws),
        this.accessIn(tx, scope!),
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

  async getProduct(
    key: string,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord | null> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const row = await tx.query.products.findFirst({
        where: and(eq(products.workspaceId, ws), eq(products.key, key)),
      });
      if (!row) return null;
      const access = await this.accessIn(tx, scope!);
      if (!canReadProduct(access, row)) return null;
      const counts = await this.itemCounts(tx, ws);
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

  async createProduct(
    input: CreateProductInput,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    return this.scoped(scope, async (tx) => {
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

  async updateProduct(
    id: string,
    patch: ProductPatch,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    return this.scoped(scope, async (tx) => {
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
          !(await this.accessIn(tx, scope!)).isOrgAdmin
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
          await this.requireGroupId(tx, ws, patch.groupId);
        }
        set.groupId = patch.groupId;
      }
      const [row] = await tx
        .update(products)
        .set(set)
        .where(and(eq(products.id, id), eq(products.workspaceId, ws)))
        .returning();
      if (!row) throw new ProductError(`Unknown product: ${id}`);
      const counts = await this.itemCounts(tx, ws);
      const access = await this.accessIn(tx, scope!);
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

  async deleteProduct(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
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

  /** Verify a group id belongs to the workspace, returning it. */
  private async requireGroupId(
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
  private async groupProductCounts(
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

  private groupRecord(
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

  async listProductGroups(
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [rows, counts] = await Promise.all([
        tx
          .select()
          .from(productGroups)
          .where(eq(productGroups.workspaceId, ws))
          .orderBy(asc(productGroups.position), asc(productGroups.name)),
        this.groupProductCounts(tx, ws),
      ]);
      return rows.map((row) => this.groupRecord(row, counts));
    });
  }

  async createProductGroup(
    input: CreateProductGroupInput,
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord> {
    return this.scoped(scope, async (tx) => {
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
        await this.requireGroupId(tx, ws, parentId);
        if (wouldExceedDepth(existing, "new-group", parentId)) {
          throw new GroupError(
            "Groups can only be nested a few levels deep.",
          );
        }
      }
      const key = groupKeyFromName(name, new Set(existing.map((g) => g.key)));
      const position =
        existing.reduce((m, g) => Math.max(m, g.position), -1) + 1;
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
      return this.groupRecord(row, new Map());
    });
  }

  async updateProductGroup(
    id: string,
    patch: ProductGroupPatch,
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord> {
    return this.scoped(scope, async (tx) => {
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
          await this.requireGroupId(tx, ws, patch.parentId);
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
            throw new GroupError(
              "Groups can only be nested a few levels deep.",
            );
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
      const counts = await this.groupProductCounts(tx, ws);
      return this.groupRecord(row, counts);
    });
  }

  async deleteProductGroup(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
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
        throw new GroupError(
          "Can't delete a group while it still has products.",
        );
      }
      const deleted = await tx
        .delete(productGroups)
        .where(and(eq(productGroups.id, id), eq(productGroups.workspaceId, ws)))
        .returning({ id: productGroups.id });
      if (!deleted[0]) throw new GroupError(`Unknown product group: ${id}`);
    });
  }

  async getGroupSummary(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<GroupSummary> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [groupRows, counts, access] = await Promise.all([
        tx
          .select()
          .from(productGroups)
          .where(eq(productGroups.workspaceId, ws))
          .orderBy(asc(productGroups.position), asc(productGroups.name)),
        this.groupProductCounts(tx, ws),
        this.accessIn(tx, scope!),
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

      const summaries = await this.productAggregates(
        tx,
        ws,
        readable.map((p) => p.id),
      );

      // Keep product order consistent with listProducts (position, then name).
      const ordered = [...readable]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((p) => summaries.get(p.id)!);

      return {
        group: this.groupRecord(group, counts),
        subgroups: groupRows
          .filter((g) => g.parentId === id)
          .map((g) => this.groupRecord(g, counts)),
        products: ordered,
      };
    });
  }

  async listBlockingEdges(scope?: WorkspaceScope): Promise<BlockingEdge[]> {
    return this.scoped(scope, async (tx) => {
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
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, ws),
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
          and(
            eq(featureLinks.workspaceId, ws),
            eq(featureLinks.type, "blocks"),
          ),
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

  /**
   * Per-product item totals, status breakdown, and per-release progress, all
   * derived at read time from one grouped scan (no denormalized counts).
   *
   * The roll-up shape both dashboards share: the caller decides which products
   * are in scope (a group's subtree, or the whole workspace) and this decides
   * what a count means, so the group and leadership dashboards cannot drift.
   */
  private async productAggregates(
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

  async getWorkspaceSummary(
    options: WorkspaceSummaryOptions,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceSummary> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [productRows, access] = await Promise.all([
        tx.select().from(products).where(eq(products.workspaceId, ws)),
        this.accessIn(tx, scope!),
      ]);
      // Same visibility rule as listProducts and the group roll-up: a product
      // the viewer cannot read contributes nothing, so no total can betray that
      // it exists.
      const readable = productRows.filter((p) => canReadProduct(access, p));
      const readableIds = readable.map((p) => p.id);

      const summaries = await this.productAggregates(tx, ws, readableIds);
      const ordered = [...readable]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((p) => summaries.get(p.id)!);

      return {
        products: ordered,
        signals: await this.workspaceSignals(tx, ws, readableIds, options),
      };
    });
  }

  /**
   * The three escalation signals, each as a true count plus a capped sample.
   *
   * Every query is restricted to `readableIds`, so an unreadable product cannot
   * leak an item's title through a signal, and each excludes archived items and
   * anything already done (a blocker on finished work is history, not a signal).
   */
  private async workspaceSignals(
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

  async listProductMembers(
    productId: string,
    scope?: WorkspaceScope,
  ): Promise<ProductMemberRecord[]> {
    return this.scoped(scope, async (tx) => {
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

  async setProductMember(
    productId: string,
    input: ProductMemberInput,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      await this.requireProductId(tx, ws, productId);
      await this.assertWorkspaceMember(tx, ws, input.userId);
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

  async removeProductMember(
    productId: string,
    userId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
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
}

/** Map a viewer-relative direction to a canonical stored edge. */
function toEdge(
  selfId: string,
  otherId: string,
  direction: RelationInput["direction"],
): { fromFeatureId: string; toFeatureId: string; type: LinkRow["type"] } {
  switch (direction) {
    case "blocks":
      return { fromFeatureId: selfId, toFeatureId: otherId, type: "blocks" };
    case "blocked_by":
      return { fromFeatureId: otherId, toFeatureId: selfId, type: "blocks" };
    case "relates_to":
      return {
        fromFeatureId: selfId,
        toFeatureId: otherId,
        type: "relates_to",
      };
    case "duplicates":
      return {
        fromFeatureId: selfId,
        toFeatureId: otherId,
        type: "duplicates",
      };
  }
}

export { specIndex };
