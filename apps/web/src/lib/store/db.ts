import { randomUUID } from "node:crypto";

import {
  canReadProduct,
  canWriteProduct,
  DEFAULT_PRODUCT_KEY,
  extractSections,
  isLeafLevel,
  isPropertyType,
  isValidParentLevel,
  productKeyFromName,
  promotedIdeaStatus,
  propertyKeyFromLabel,
  resolveIdeaStages,
  resolveLevels,
  resolveLevelUpdate,
  type IdeaStage,
  type PropertyDef,
  type WorkspaceLevel,
} from "@specboard/core";
import {
  and,
  asc,
  boardPreferences,
  count,
  createDb,
  desc,
  detailTemplates,
  eq,
  featureGithubLinks,
  featureLinks,
  features,
  ideaSettings,
  ideaStatuses,
  ideaVotes,
  ideas,
  inArray,
  members,
  or,
  outboxEvents,
  productMembers,
  products,
  releases,
  repositories,
  savedViews,
  sql,
  specIndex,
  users,
  workspaceLevels,
  workspaceProperties,
  workspaceStageGates,
  workspaceStatuses,
  featureGateCompletions,
  type Database,
} from "@specboard/db";

import {
  compareReleases,
  DetailTemplateError,
  FeatureError,
  LevelError,
  ProductError,
  PropertyError,
  RelationError,
  ReleaseError,
  RELEASE_STATUSES,
  type BoardPreferences,
  type CreateFeatureInput,
  type CreateProductInput,
  type DetailTemplate,
  type DetailTemplateInput,
  type DetailTemplatePatch,
  type LevelUpdate,
  type OutboxEmit,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureRelation,
  type FeatureStore,
  type GithubLink,
  type GithubLinkAggregate,
  type GithubLinkKind,
  IdeaError,
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type ProductAccess,
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
  type ReleaseStatus,
  type StageGate,
  type StageGateInput,
  StageGateError,
  type StatusStageInput,
  type WorkspaceStatus,
  type ResolvedGithubLink,
  type SavedView,
  type SavedViewFilters,
  type SavedViewInput,
  type WorkspaceScope,
} from "./types";

/** Normalize the jsonb filters column into the typed filter bundle. */
function toSavedViewFilters(value: unknown): SavedViewFilters {
  const out: SavedViewFilters = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") out[k] = v;
    }
  }
  return out;
}

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

/** The terminal status used for hierarchy roll-up progress. */
function isDone(status: string): boolean {
  return status === "done";
}

/** Normalize the jsonb custom-fields column into the UI's value map. */
function toCustomFields(value: unknown): Record<string, CustomFieldValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, CustomFieldValue>)
    : {};
}

function emptyAgg(): GithubLinkAggregate {
  return { openPrs: 0, mergedPrs: 0, issues: 0, branches: 0, total: 0 };
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

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ProductVisibilityRow = { id: string; visibility: "org" | "private" };

function canReadProductId(
  access: ProductAccess,
  productById: ReadonlyMap<string, ProductVisibilityRow>,
  productId: string | null,
): boolean {
  if (productId === null) return true;
  const product = productById.get(productId);
  return product ? canReadProduct(access, product) : false;
}

function canWriteProductId(
  access: ProductAccess,
  productId: string | null,
): boolean {
  if (productId === null) return access.isOrgAdmin;
  return canWriteProduct(access, productId);
}

/** Postgres-backed store (self-host compose stack or hosted Postgres). */
export class DbStore implements FeatureStore {
  private readonly db: Database;

  constructor(connectionString: string) {
    this.db = createDb(connectionString);
  }

  /**
   * Run `fn` inside a transaction scoped to `scope`: it sets the
   * `app.user_id` session variable RLS keys on (transaction-local, so it must
   * live in a transaction), and callers additionally filter by `workspaceId`.
   * Refuses to run unscoped because that would expose every tenant's rows, since the
   * app still connects as the table owner (RLS bypassed until the
   * `specboard_app` non-owner role lands; see docs/PLAN-fly-better-auth.md).
   */
  private async scoped<T>(
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
  private async writeOutbox(
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
      const specById = new Map(rows.map((r) => [r.id, r.specId]));
      const childCount = new Map<string, number>();
      const childDone = new Map<string, number>();
      for (const r of rows) {
        if (!r.parentId || !visibleIds.has(r.parentId)) continue;
        childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
        if (isDone(r.status))
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
        isDbNative: row.repoId === null,
        productId: row.productId,
        status: row.status,
        rank: row.rank,
        tags: row.tags,
        releaseId: row.releaseId,
        assigneeId: row.assigneeId,
        customFields: toCustomFields(row.customFields),
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
      const childRowsRaw = await tx
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
        );
      const childRows = childRowsRaw
        .filter((child) =>
          canReadProductId(access, productById, child.productId),
        )
        .map(({ productId: _productId, ...child }) => child);

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
        isDbNative: row.repoId === null,
        productId: row.productId,
        status: row.status,
        rank: row.rank,
        tags: row.tags,
        releaseId: row.releaseId,
        assigneeId: row.assigneeId,
        assigneeName,
        customFields: toCustomFields(row.customFields),
        path: row.index?.path ?? "",
        content,
        sections: extractSections(content),
        relations,
        blocksCount: relations.filter((r) => r.direction === "blocks").length,
        blockedByCount: relations.filter((r) => r.direction === "blocked_by")
          .length,
        parentSpecId,
        parentTitle,
        children: childRows,
        childCount: childRows.length,
        childDoneCount: childRows.filter((c) => isDone(c.status)).length,
        githubSummary,
        githubLinks,
      };
    });
  }

  /** The workspace's hierarchy levels, ordered top → leaf (default if none). */
  private async levelsIn(
    tx: Tx,
    workspaceId: string,
  ): Promise<WorkspaceLevel[]> {
    const rows = await tx
      .select({
        key: workspaceLevels.key,
        label: workspaceLevels.label,
        position: workspaceLevels.position,
        isLeaf: workspaceLevels.isLeaf,
        cardFields: workspaceLevels.cardFields,
        detailTemplateId: workspaceLevels.detailTemplateId,
      })
      .from(workspaceLevels)
      .where(eq(workspaceLevels.workspaceId, workspaceId))
      .orderBy(asc(workspaceLevels.position));
    return resolveLevels(
      rows.map(({ cardFields, detailTemplateId, ...rest }) => ({
        ...rest,
        fields: Array.isArray(cardFields) ? (cardFields as string[]) : null,
        detailTemplateId: detailTemplateId ?? null,
      })),
    );
  }

  async listLevels(scope?: WorkspaceScope): Promise<WorkspaceLevel[]> {
    return this.scoped(scope, (tx) => this.levelsIn(tx, scope!.workspaceId));
  }

  async updateLevels(
    updates: LevelUpdate[],
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const current = await this.levelsIn(tx, ws);

      let resolved;
      try {
        resolved = resolveLevelUpdate(current, updates);
      } catch (err) {
        throw new LevelError(
          err instanceof Error ? err.message : "Invalid levels.",
        );
      }

      // A level can only be removed once nothing references it (FK aside, the
      // items would otherwise be stranded at an unknown level).
      if (resolved.removedKeys.length > 0) {
        const used = await tx
          .select({ level: features.level })
          .from(features)
          .where(
            and(
              eq(features.workspaceId, ws),
              inArray(features.level, resolved.removedKeys),
            ),
          )
          .limit(1);
        if (used[0]) {
          throw new LevelError(
            `Can't remove the "${used[0].level}" level while items still use it.`,
          );
        }
        await tx
          .delete(workspaceLevels)
          .where(
            and(
              eq(workspaceLevels.workspaceId, ws),
              inArray(workspaceLevels.key, resolved.removedKeys),
            ),
          );
      }

      for (const level of resolved.levels) {
        await tx
          .insert(workspaceLevels)
          .values({
            workspaceId: ws,
            key: level.key,
            label: level.label,
            position: level.position,
            isLeaf: level.isLeaf,
            cardFields: level.fields ?? null,
          })
          .onConflictDoUpdate({
            target: [workspaceLevels.workspaceId, workspaceLevels.key],
            set: {
              label: level.label,
              position: level.position,
              isLeaf: level.isLeaf,
              cardFields: level.fields ?? null,
            },
          });
      }
      return resolved.levels;
    });
  }

  async updateLevelFields(
    fields: Record<string, string[] | null>,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const current = await this.levelsIn(tx, ws);
      const byKey = new Map(current.map((l) => [l.key, l]));
      for (const key of Object.keys(fields)) {
        if (!byKey.has(key)) throw new LevelError(`Unknown level: ${key}`);
      }
      // Upsert: a fresh workspace may still be on the unpersisted default
      // levels, so the row might not exist yet.
      for (const [key, value] of Object.entries(fields)) {
        const level = byKey.get(key)!;
        await tx
          .insert(workspaceLevels)
          .values({
            workspaceId: ws,
            key: level.key,
            label: level.label,
            position: level.position,
            isLeaf: level.isLeaf,
            cardFields: value,
          })
          .onConflictDoUpdate({
            target: [workspaceLevels.workspaceId, workspaceLevels.key],
            set: { cardFields: value },
          });
      }
      return this.levelsIn(tx, ws);
    });
  }

  async updateLevelTemplates(
    templates: Record<string, string | null>,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const current = await this.levelsIn(tx, ws);
      const byKey = new Map(current.map((l) => [l.key, l]));
      for (const key of Object.keys(templates)) {
        if (!byKey.has(key)) throw new LevelError(`Unknown level: ${key}`);
      }
      // Validate the referenced templates belong to this workspace.
      const wanted = [
        ...new Set(Object.values(templates).filter((v): v is string => !!v)),
      ];
      if (wanted.length > 0) {
        const known = await tx
          .select({ id: detailTemplates.id })
          .from(detailTemplates)
          .where(
            and(
              eq(detailTemplates.workspaceId, ws),
              inArray(detailTemplates.id, wanted),
            ),
          );
        const knownIds = new Set(known.map((t) => t.id));
        for (const id of wanted) {
          if (!knownIds.has(id))
            throw new LevelError(`Unknown detail template: ${id}`);
        }
      }
      for (const [key, value] of Object.entries(templates)) {
        const level = byKey.get(key)!;
        await tx
          .insert(workspaceLevels)
          .values({
            workspaceId: ws,
            key: level.key,
            label: level.label,
            position: level.position,
            isLeaf: level.isLeaf,
            cardFields: level.fields ?? null,
            detailTemplateId: value,
          })
          .onConflictDoUpdate({
            target: [workspaceLevels.workspaceId, workspaceLevels.key],
            set: { detailTemplateId: value },
          });
      }
      return this.levelsIn(tx, ws);
    });
  }

  async listDetailTemplates(scope?: WorkspaceScope): Promise<DetailTemplate[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx
        .select({
          id: detailTemplates.id,
          name: detailTemplates.name,
          body: detailTemplates.body,
        })
        .from(detailTemplates)
        .where(eq(detailTemplates.workspaceId, scope!.workspaceId))
        .orderBy(asc(detailTemplates.name));
      return rows;
    });
  }

  async createDetailTemplate(
    input: DetailTemplateInput,
    scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    return this.scoped(scope, async (tx) => {
      const name = input.name.trim();
      if (!name) throw new DetailTemplateError("Template name is required.");
      const [row] = await tx
        .insert(detailTemplates)
        .values({
          workspaceId: scope!.workspaceId,
          name,
          body: input.body ?? "",
        })
        .onConflictDoNothing({
          target: [detailTemplates.workspaceId, detailTemplates.name],
        })
        .returning({
          id: detailTemplates.id,
          name: detailTemplates.name,
          body: detailTemplates.body,
        });
      if (!row)
        throw new DetailTemplateError(
          `A template named "${name}" already exists.`,
        );
      return row;
    });
  }

  async updateDetailTemplate(
    id: string,
    patch: DetailTemplatePatch,
    scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new DetailTemplateError("Template name is required.");
        set.name = name;
      }
      if (patch.body !== undefined) set.body = patch.body;
      const [row] = await tx
        .update(detailTemplates)
        .set(set)
        .where(
          and(eq(detailTemplates.id, id), eq(detailTemplates.workspaceId, ws)),
        )
        .returning({
          id: detailTemplates.id,
          name: detailTemplates.name,
          body: detailTemplates.body,
        });
      if (!row) throw new DetailTemplateError(`Unknown template: ${id}`);
      return row;
    });
  }

  async deleteDetailTemplate(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
      // workspace_levels.detail_template_id is ON DELETE SET NULL, so pointing
      // levels fall back to a blank body automatically.
      const deleted = await tx
        .delete(detailTemplates)
        .where(
          and(
            eq(detailTemplates.id, id),
            eq(detailTemplates.workspaceId, scope!.workspaceId),
          ),
        )
        .returning({ id: detailTemplates.id });
      if (!deleted[0]) throw new DetailTemplateError(`Unknown template: ${id}`);
    });
  }

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
      if (isLeafLevel(input.level, levels))
        throw new FeatureError(
          "Leaf-level items come from specs and can't be created here.",
        );

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
      if (input.assigneeId) await this.assertWorkspaceMember(tx, ws, input.assigneeId);

      // DB-native items have no repo/spec; spec_id mirrors the row id so every
      // row stays uniformly routable by specId.
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
          tags: input.tags ?? [],
          details: input.details?.trim() ? input.details : null,
          parentId,
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
        assigneeId: row.assigneeId,
        customFields: toCustomFields(row.customFields),
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
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const row = await tx
        .select({
          id: features.id,
          repoId: features.repoId,
          productId: features.productId,
        })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
      if (!row[0]) throw new FeatureError(`Unknown work item: ${specId}`);
      const access = await this.accessIn(tx, scope!);
      if (!canWriteProductId(access, row[0].productId)) {
        throw new FeatureError(
          "Your role does not permit editing this product.",
        );
      }
      if (row[0].repoId !== null)
        throw new FeatureError(
          "Spec-backed items can't be deleted here. Remove the spec in git.",
        );
      // Children's parent_id is ON DELETE SET NULL, so they're orphaned, not deleted.
      await tx
        .delete(features)
        .where(and(eq(features.id, row[0].id), eq(features.workspaceId, ws)));
      if (emit) await this.writeOutbox(tx, scope!, emit);
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
      const current = await tx
        .select({ productId: features.productId })
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
      // A release assignment must point at a release in this workspace.
      if (typeof rest.releaseId === "string" && rest.releaseId) {
        const release = await tx
          .select({ id: releases.id })
          .from(releases)
          .where(
            and(eq(releases.id, rest.releaseId), eq(releases.workspaceId, ws)),
          )
          .limit(1);
        if (!release[0]) {
          throw new RelationError(`Unknown release: ${rest.releaseId}`);
        }
      }
      const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
      if (parentSpecId !== undefined) {
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
      await tx
        .update(features)
        .set(set)
        .where(
          and(
            eq(features.specId, specId),
            eq(features.workspaceId, scope!.workspaceId),
          ),
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
        })
        // Re-linking the same url refreshes the cached title/state.
        .onConflictDoUpdate({
          target: [featureGithubLinks.featureId, featureGithubLinks.url],
          set: { title: link.title, state: link.state },
        });
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

  async listSavedViews(scope?: WorkspaceScope): Promise<SavedView[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx
        .select({
          id: savedViews.id,
          name: savedViews.name,
          view: savedViews.view,
          filters: savedViews.filters,
        })
        .from(savedViews)
        .where(
          and(
            eq(savedViews.workspaceId, scope!.workspaceId),
            eq(savedViews.userId, scope!.userId),
          ),
        )
        .orderBy(desc(savedViews.createdAt));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        view: r.view,
        filters: toSavedViewFilters(r.filters),
      }));
    });
  }

  async createSavedView(
    input: SavedViewInput,
    scope?: WorkspaceScope,
  ): Promise<SavedView> {
    return this.scoped(scope, async (tx) => {
      const [row] = await tx
        .insert(savedViews)
        .values({
          workspaceId: scope!.workspaceId,
          userId: scope!.userId,
          name: input.name,
          view: input.view,
          filters: input.filters,
        })
        .returning({
          id: savedViews.id,
          name: savedViews.name,
          view: savedViews.view,
          filters: savedViews.filters,
        });
      if (!row) throw new Error("Failed to create saved view.");
      return {
        id: row.id,
        name: row.name,
        view: row.view,
        filters: toSavedViewFilters(row.filters),
      };
    });
  }

  async deleteSavedView(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
      await tx
        .delete(savedViews)
        .where(
          and(
            eq(savedViews.id, id),
            eq(savedViews.workspaceId, scope!.workspaceId),
            eq(savedViews.userId, scope!.userId),
          ),
        );
    });
  }

  async getBoardPreferences(
    scope?: WorkspaceScope,
  ): Promise<BoardPreferences | null> {
    return this.scoped(scope, async (tx) => {
      const row = await tx.query.boardPreferences.findFirst({
        where: and(
          eq(boardPreferences.workspaceId, scope!.workspaceId),
          eq(boardPreferences.userId, scope!.userId),
        ),
      });
      if (!row) return null;
      return {
        cardFields: Array.isArray(row.cardFields)
          ? (row.cardFields as string[])
          : null,
        featured: row.featured,
      };
    });
  }

  async setBoardPreferences(
    prefs: BoardPreferences,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      await tx
        .insert(boardPreferences)
        .values({
          workspaceId: scope!.workspaceId,
          userId: scope!.userId,
          cardFields: prefs.cardFields ?? [],
          featured: prefs.featured,
        })
        .onConflictDoUpdate({
          target: [boardPreferences.workspaceId, boardPreferences.userId],
          set: {
            cardFields: prefs.cardFields ?? [],
            featured: prefs.featured,
            updatedAt: new Date(),
          },
        });
    });
  }

  // ── Custom properties ─────────────────────────────────────────────────

  private async propertiesIn(tx: Tx, ws: string): Promise<PropertyDef[]> {
    const rows = await tx
      .select()
      .from(workspaceProperties)
      .where(eq(workspaceProperties.workspaceId, ws))
      .orderBy(asc(workspaceProperties.position), asc(workspaceProperties.createdAt));
    return rows.map(toPropertyDef);
  }

  async listProperties(scope?: WorkspaceScope): Promise<PropertyDef[]> {
    return this.scoped(scope, (tx) => this.propertiesIn(tx, scope!.workspaceId));
  }

  async listStatuses(scope?: WorkspaceScope): Promise<WorkspaceStatus[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(workspaceStatuses)
        .where(eq(workspaceStatuses.workspaceId, scope!.workspaceId))
        .orderBy(asc(workspaceStatuses.position));
      return rows.map((r) => ({
        key: r.key,
        label: r.label,
        position: r.position,
      }));
    });
  }

  async replaceStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
  ): Promise<WorkspaceStatus[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const keys = stages.map((s) => s.key);
      const fallback = keys[0]!;
      // `archived` is a system status and always remains valid so archived
      // items aren't swept back onto the board.
      const validKeys = new Set([...keys, "archived"]);

      // Re-home any items whose current status is no longer a stage.
      const used = await tx
        .selectDistinct({ status: features.status })
        .from(features)
        .where(eq(features.workspaceId, ws));
      const orphaned = used
        .map((u) => u.status)
        .filter((s) => !validKeys.has(s));
      if (orphaned.length > 0) {
        await tx
          .update(features)
          .set({ status: fallback, updatedAt: new Date() })
          .where(
            and(
              eq(features.workspaceId, ws),
              inArray(features.status, orphaned),
            ),
          );
      }

      // Drop stage gates whose stage was removed (renames keep the key, so only
      // deletions strand gates). Their completions cascade with the gate rows,
      // so a removed-then-recreated stage doesn't resurrect stale checklists.
      const usedStages = await tx
        .selectDistinct({ stageKey: workspaceStageGates.stageKey })
        .from(workspaceStageGates)
        .where(eq(workspaceStageGates.workspaceId, ws));
      const orphanedGateStages = usedStages
        .map((r) => r.stageKey)
        .filter((s) => !validKeys.has(s));
      if (orphanedGateStages.length > 0) {
        await tx
          .delete(workspaceStageGates)
          .where(
            and(
              eq(workspaceStageGates.workspaceId, ws),
              inArray(workspaceStageGates.stageKey, orphanedGateStages),
            ),
          );
      }

      // Replace the stage set wholesale (positions follow the given order).
      await tx
        .delete(workspaceStatuses)
        .where(eq(workspaceStatuses.workspaceId, ws));
      if (stages.length > 0) {
        await tx.insert(workspaceStatuses).values(
          stages.map((s, i) => ({
            workspaceId: ws,
            key: s.key,
            label: s.label,
            position: i,
          })),
        );
      }
      return stages.map((s, i) => ({ key: s.key, label: s.label, position: i }));
    });
  }

  async listStageGates(scope?: WorkspaceScope): Promise<StageGate[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(workspaceStageGates)
        .where(eq(workspaceStageGates.workspaceId, scope!.workspaceId))
        .orderBy(
          asc(workspaceStageGates.stageKey),
          asc(workspaceStageGates.position),
        );
      return rows.map((r) => ({
        id: r.id,
        stageKey: r.stageKey,
        label: r.label,
        position: r.position,
      }));
    });
  }

  async replaceStageGates(
    gates: StageGateInput[],
    scope?: WorkspaceScope,
  ): Promise<StageGate[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      // Position is per-stage: the nth gate listed for a given stage.
      const perStage = new Map<string, number>();
      const resolved = gates.map((g) => {
        const pos = perStage.get(g.stageKey) ?? 0;
        perStage.set(g.stageKey, pos + 1);
        return { id: g.id, stageKey: g.stageKey, label: g.label, position: pos };
      });

      // Reconcile against the existing set so kept gates (matched by id) retain
      // their per-item completions; only removed gates cascade-delete theirs.
      const existing = await tx
        .select({ id: workspaceStageGates.id })
        .from(workspaceStageGates)
        .where(eq(workspaceStageGates.workspaceId, ws));
      const existingIds = new Set(existing.map((r) => r.id));
      const keepIds = new Set(
        resolved.map((g) => g.id).filter((id): id is string => !!id && existingIds.has(id)),
      );

      // Delete gates that are gone from the new set.
      const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
      if (toDelete.length > 0) {
        await tx
          .delete(workspaceStageGates)
          .where(
            and(
              eq(workspaceStageGates.workspaceId, ws),
              inArray(workspaceStageGates.id, toDelete),
            ),
          );
      }

      // Update kept gates in place; insert new ones.
      for (const g of resolved) {
        if (g.id && keepIds.has(g.id)) {
          await tx
            .update(workspaceStageGates)
            .set({ stageKey: g.stageKey, label: g.label, position: g.position })
            .where(
              and(
                eq(workspaceStageGates.id, g.id),
                eq(workspaceStageGates.workspaceId, ws),
              ),
            );
        } else {
          await tx.insert(workspaceStageGates).values({
            workspaceId: ws,
            stageKey: g.stageKey,
            label: g.label,
            position: g.position,
          });
        }
      }

      const rows = await tx
        .select()
        .from(workspaceStageGates)
        .where(eq(workspaceStageGates.workspaceId, ws))
        .orderBy(
          asc(workspaceStageGates.stageKey),
          asc(workspaceStageGates.position),
        );
      return rows.map((r) => ({
        id: r.id,
        stageKey: r.stageKey,
        label: r.label,
        position: r.position,
      }));
    });
  }

  async listGateCompletions(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<string[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const feat = await tx
        .select({ id: features.id })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
      if (!feat[0]) return [];
      const rows = await tx
        .select({ gateId: featureGateCompletions.gateId })
        .from(featureGateCompletions)
        .where(
          and(
            eq(featureGateCompletions.featureId, feat[0].id),
            eq(featureGateCompletions.workspaceId, ws),
          ),
        );
      return rows.map((r) => r.gateId);
    });
  }

  async setGateCompletion(
    specId: string,
    gateId: string,
    completed: boolean,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const feat = await tx
        .select({ id: features.id, productId: features.productId })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
      if (!feat[0]) throw new StageGateError(`Unknown feature: ${specId}`);
      const access = await this.accessIn(tx, scope!);
      if (!canWriteProductId(access, feat[0].productId)) {
        throw new StageGateError(
          "Your role does not permit editing this product.",
        );
      }
      // The gate must exist in this workspace (RLS also enforces the tenant).
      const gate = await tx
        .select({ id: workspaceStageGates.id })
        .from(workspaceStageGates)
        .where(
          and(
            eq(workspaceStageGates.id, gateId),
            eq(workspaceStageGates.workspaceId, ws),
          ),
        );
      if (!gate[0]) throw new StageGateError("Unknown stage gate.");

      if (completed) {
        await tx
          .insert(featureGateCompletions)
          .values({
            workspaceId: ws,
            featureId: feat[0].id,
            gateId,
            completedBy: scope!.userId,
          })
          .onConflictDoNothing({
            target: [
              featureGateCompletions.featureId,
              featureGateCompletions.gateId,
            ],
          });
      } else {
        await tx
          .delete(featureGateCompletions)
          .where(
            and(
              eq(featureGateCompletions.featureId, feat[0].id),
              eq(featureGateCompletions.gateId, gateId),
              eq(featureGateCompletions.workspaceId, ws),
            ),
          );
      }
    });
  }

  async createProperty(
    input: PropertyInput,
    scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const label = input.label.trim();
      if (!label) throw new PropertyError("Property label is required.");
      if (!isPropertyType(input.type)) {
        throw new PropertyError(`Unknown property type: ${String(input.type)}`);
      }
      const existing = await this.propertiesIn(tx, ws);
      const key = propertyKeyFromLabel(label, new Set(existing.map((p) => p.key)));
      const levels = await this.normalizeLevels(tx, ws, input.levels);
      const position =
        existing.reduce((m, p) => Math.max(m, p.position), -1) + 1;
      const [row] = await tx
        .insert(workspaceProperties)
        .values({
          workspaceId: ws,
          key,
          label,
          type: input.type,
          options: normalizeOptions(input.type, input.options),
          levels,
          position,
        })
        .returning();
      if (!row) throw new PropertyError("Failed to create property.");
      return toPropertyDef(row);
    });
  }

  async updateProperty(
    id: string,
    patch: PropertyPatch,
    scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const current = await tx.query.workspaceProperties.findFirst({
        where: and(
          eq(workspaceProperties.id, id),
          eq(workspaceProperties.workspaceId, ws),
        ),
      });
      if (!current) throw new PropertyError(`Unknown property: ${id}`);
      const set: Record<string, unknown> = {};
      if (patch.label !== undefined) {
        const label = patch.label.trim();
        if (!label) throw new PropertyError("Property label is required.");
        set.label = label;
      }
      if (patch.options !== undefined) {
        set.options = normalizeOptions(
          current.type as PropertyDef["type"],
          patch.options,
        );
      }
      if (patch.levels !== undefined) {
        set.levels = await this.normalizeLevels(tx, ws, patch.levels);
      }
      if (patch.position !== undefined) set.position = patch.position;
      if (Object.keys(set).length === 0) return toPropertyDef(current);
      const [row] = await tx
        .update(workspaceProperties)
        .set(set)
        .where(
          and(
            eq(workspaceProperties.id, id),
            eq(workspaceProperties.workspaceId, ws),
          ),
        )
        .returning();
      if (!row) throw new PropertyError(`Unknown property: ${id}`);
      return toPropertyDef(row);
    });
  }

  async deleteProperty(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const deleted = await tx
        .delete(workspaceProperties)
        .where(
          and(
            eq(workspaceProperties.id, id),
            eq(workspaceProperties.workspaceId, scope!.workspaceId),
          ),
        )
        .returning({ id: workspaceProperties.id });
      if (!deleted[0]) throw new PropertyError(`Unknown property: ${id}`);
    });
  }

  /** Validate a property's level list against the workspace hierarchy. */
  private async normalizeLevels(
    tx: Tx,
    ws: string,
    levels: string[] | null | undefined,
  ): Promise<string[] | null> {
    if (levels == null) return null;
    const known = new Set((await this.levelsIn(tx, ws)).map((l) => l.key));
    const cleaned = [...new Set(levels.map((l) => l.trim()).filter(Boolean))];
    for (const key of cleaned) {
      if (!known.has(key)) throw new PropertyError(`Unknown level: ${key}`);
    }
    return cleaned;
  }

  // ── Releases ──────────────────────────────────────────────────────────

  async listReleases(scope?: WorkspaceScope): Promise<ReleaseRecord[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [rows, counts] = await Promise.all([
        tx.select().from(releases).where(eq(releases.workspaceId, ws)),
        tx
          .select({ releaseId: features.releaseId, n: count() })
          .from(features)
          .where(eq(features.workspaceId, ws))
          .groupBy(features.releaseId),
      ]);
      const countById = new Map<string, number>();
      for (const c of counts) {
        if (c.releaseId) countById.set(c.releaseId, Number(c.n));
      }
      return rows
        .map((r) => toReleaseRecord(r, countById.get(r.id) ?? 0))
        .sort(compareReleases);
    });
  }

  async createRelease(
    input: ReleaseInput,
    scope?: WorkspaceScope,
  ): Promise<ReleaseRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const name = input.name.trim();
      if (!name) throw new ReleaseError("Release name is required.");
      const [row] = await tx
        .insert(releases)
        .values({
          workspaceId: ws,
          name,
          status: normalizeReleaseStatus(input.status),
          startDate: input.startDate ?? null,
          targetDate: input.targetDate ?? null,
          notes: input.notes ?? null,
        })
        .onConflictDoNothing({ target: [releases.workspaceId, releases.name] })
        .returning();
      if (!row) throw new ReleaseError(`A release named "${name}" already exists.`);
      return toReleaseRecord(row, 0);
    });
  }

  async updateRelease(
    id: string,
    patch: ReleasePatch,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
  ): Promise<ReleaseRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new ReleaseError("Release name is required.");
        set.name = name;
      }
      if (patch.status !== undefined) {
        set.status = normalizeReleaseStatus(patch.status);
      }
      if (patch.startDate !== undefined) set.startDate = patch.startDate;
      if (patch.targetDate !== undefined) set.targetDate = patch.targetDate;
      if (patch.notes !== undefined) set.notes = patch.notes;
      const [row] = await tx
        .update(releases)
        .set(set)
        .where(and(eq(releases.id, id), eq(releases.workspaceId, ws)))
        .returning();
      if (!row) throw new ReleaseError(`Unknown release: ${id}`);
      const items = await tx
        .select({ n: count() })
        .from(features)
        .where(and(eq(features.workspaceId, ws), eq(features.releaseId, id)));
      if (emit) await this.writeOutbox(tx, scope!, emit);
      return toReleaseRecord(row, Number(items[0]?.n ?? 0));
    });
  }

  async deleteRelease(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
      // features.release_id is ON DELETE SET NULL, so items are unscheduled.
      const deleted = await tx
        .delete(releases)
        .where(
          and(eq(releases.id, id), eq(releases.workspaceId, scope!.workspaceId)),
        )
        .returning({ id: releases.id });
      if (!deleted[0]) throw new ReleaseError(`Unknown release: ${id}`);
    });
  }

  // ── Ideas ─────────────────────────────────────────────────────────────

  /**
   * Load one idea with its derived fields (vote count, viewer vote, author +
   * promotion labels). Used by every single-idea return so create/update/vote
   * all shape the record identically. Returns null when the idea is gone or the
   * acting user can't read its product.
   */
  private async hydrateIdea(
    tx: Tx,
    scope: WorkspaceScope,
    id: string,
  ): Promise<IdeaRecord | null> {
    const ws = scope.workspaceId;
    const row = await tx.query.ideas.findFirst({
      where: and(eq(ideas.id, id), eq(ideas.workspaceId, ws)),
    });
    if (!row) return null;
    const [access, productById] = await Promise.all([
      this.accessIn(tx, scope),
      this.productVisibilityIn(tx, ws),
    ]);
    if (!canReadProductId(access, productById, row.productId)) return null;

    const [votes, mine, author, promoted] = await Promise.all([
      tx
        .select({ n: count() })
        .from(ideaVotes)
        .where(eq(ideaVotes.ideaId, id)),
      tx
        .select({ id: ideaVotes.id })
        .from(ideaVotes)
        .where(and(eq(ideaVotes.ideaId, id), eq(ideaVotes.userId, scope.userId)))
        .limit(1),
      row.authorId
        ? tx.query.users.findFirst({
            where: eq(users.id, row.authorId),
            columns: { name: true },
          })
        : Promise.resolve(undefined),
      row.promotedFeatureId
        ? tx
            .select({ specId: features.specId, title: features.title })
            .from(features)
            .where(eq(features.id, row.promotedFeatureId))
            .limit(1)
        : Promise.resolve([] as { specId: string; title: string }[]),
    ]);

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      productId: row.productId,
      authorName: author?.name ?? null,
      submitterName: row.submitterName,
      voteCount: Number(votes[0]?.n ?? 0),
      viewerHasVoted: mine.length > 0,
      promotedFeatureSpecId: promoted[0]?.specId ?? null,
      promotedFeatureTitle: promoted[0]?.title ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listIdeas(scope?: WorkspaceScope): Promise<IdeaRecord[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [rows, access, productById] = await Promise.all([
        tx.query.ideas.findMany({ where: eq(ideas.workspaceId, ws) }),
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, ws),
      ]);
      const visible = rows.filter((r) =>
        canReadProductId(access, productById, r.productId),
      );
      if (visible.length === 0) return [];
      const ids = visible.map((r) => r.id);

      const [voteRows, myVotes, authorRows, promotedRows] = await Promise.all([
        tx
          .select({ ideaId: ideaVotes.ideaId, n: count() })
          .from(ideaVotes)
          .where(eq(ideaVotes.workspaceId, ws))
          .groupBy(ideaVotes.ideaId),
        tx
          .select({ ideaId: ideaVotes.ideaId })
          .from(ideaVotes)
          .where(
            and(
              eq(ideaVotes.workspaceId, ws),
              eq(ideaVotes.userId, scope!.userId),
            ),
          ),
        (() => {
          const authorIds = [
            ...new Set(visible.map((r) => r.authorId).filter(Boolean)),
          ] as string[];
          return authorIds.length
            ? tx
                .select({ id: users.id, name: users.name })
                .from(users)
                .where(inArray(users.id, authorIds))
            : Promise.resolve([] as { id: string; name: string }[]);
        })(),
        (() => {
          const featureIds = [
            ...new Set(visible.map((r) => r.promotedFeatureId).filter(Boolean)),
          ] as string[];
          return featureIds.length
            ? tx
                .select({
                  id: features.id,
                  specId: features.specId,
                  title: features.title,
                })
                .from(features)
                .where(inArray(features.id, featureIds))
            : Promise.resolve(
                [] as { id: string; specId: string; title: string }[],
              );
        })(),
      ]);

      const countById = new Map(
        voteRows.map((v) => [v.ideaId, Number(v.n)] as const),
      );
      const votedIds = new Set(myVotes.map((v) => v.ideaId));
      const authorById = new Map(authorRows.map((a) => [a.id, a.name] as const));
      const promotedById = new Map(promotedRows.map((f) => [f.id, f] as const));

      return visible
        .map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          status: r.status,
          productId: r.productId,
          authorName: r.authorId ? (authorById.get(r.authorId) ?? null) : null,
          submitterName: r.submitterName,
          voteCount: countById.get(r.id) ?? 0,
          viewerHasVoted: votedIds.has(r.id),
          promotedFeatureSpecId: r.promotedFeatureId
            ? (promotedById.get(r.promotedFeatureId)?.specId ?? null)
            : null,
          promotedFeatureTitle: r.promotedFeatureId
            ? (promotedById.get(r.promotedFeatureId)?.title ?? null)
            : null,
          createdAt: r.createdAt.toISOString(),
        }))
        .sort(
          (a, b) =>
            b.voteCount - a.voteCount ||
            (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
        );
    });
  }

  async createIdea(
    input: IdeaInput,
    scope?: WorkspaceScope,
  ): Promise<IdeaRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const title = input.title.trim();
      if (!title) throw new IdeaError("Idea title is required.");
      const [access, productById] = await Promise.all([
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, ws),
      ]);
      const productId = input.productId
        ? await this.requireProductId(tx, ws, input.productId)
        : await this.defaultProductId(tx, ws);
      // Capturing an idea for a product requires being able to see that backlog.
      if (!canReadProductId(access, productById, productId)) {
        throw new IdeaError("Unknown product.");
      }
      const [row] = await tx
        .insert(ideas)
        .values({
          workspaceId: ws,
          productId,
          title,
          description: input.description?.trim() ? input.description.trim() : null,
          status: "new",
          authorId: scope!.userId,
        })
        .returning({ id: ideas.id });
      if (!row) throw new IdeaError("Failed to create idea.");
      const idea = await this.hydrateIdea(tx, scope!, row.id);
      if (!idea) throw new IdeaError("Failed to load the new idea.");
      return idea;
    });
  }

  async updateIdea(
    id: string,
    patch: IdeaPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const current = await tx.query.ideas.findFirst({
        where: and(eq(ideas.id, id), eq(ideas.workspaceId, ws)),
      });
      if (!current) throw new IdeaError(`Unknown idea: ${id}`);
      const access = await this.accessIn(tx, scope!);
      // Editing an idea (status, retitle, reassign) requires write on its product.
      if (!canWriteProductId(access, current.productId)) {
        throw new IdeaError("Your role does not permit editing this idea.");
      }
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new IdeaError("Idea title is required.");
        set.title = title;
      }
      if (patch.description !== undefined) {
        set.description = patch.description?.trim() ? patch.description.trim() : null;
      }
      if (patch.status !== undefined) {
        const stages = await this.ideaStagesIn(tx, ws);
        if (!stages.some((s) => s.key === patch.status)) {
          throw new IdeaError(`Unknown idea status: ${patch.status}`);
        }
        set.status = patch.status;
      }
      if (patch.productId !== undefined) {
        const productId = patch.productId
          ? await this.requireProductId(tx, ws, patch.productId)
          : await this.defaultProductId(tx, ws);
        if (!canWriteProductId(access, productId)) {
          throw new IdeaError("Your role does not permit that product.");
        }
        set.productId = productId;
      }
      await tx
        .update(ideas)
        .set(set)
        .where(and(eq(ideas.id, id), eq(ideas.workspaceId, ws)));
      const idea = await this.hydrateIdea(tx, scope!, id);
      if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
      return idea;
    });
  }

  async deleteIdea(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const current = await tx.query.ideas.findFirst({
        where: and(eq(ideas.id, id), eq(ideas.workspaceId, ws)),
        columns: { productId: true },
      });
      if (!current) throw new IdeaError(`Unknown idea: ${id}`);
      const access = await this.accessIn(tx, scope!);
      if (!canWriteProductId(access, current.productId)) {
        throw new IdeaError("Your role does not permit deleting this idea.");
      }
      // idea_votes cascade on the FK.
      await tx.delete(ideas).where(and(eq(ideas.id, id), eq(ideas.workspaceId, ws)));
    });
  }

  async voteIdea(id: string, scope?: WorkspaceScope): Promise<IdeaRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const idea = await this.hydrateIdea(tx, scope!, id);
      if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
      // Idempotent: the unique (idea, user) index makes a repeat vote a no-op.
      await tx
        .insert(ideaVotes)
        .values({ workspaceId: ws, ideaId: id, userId: scope!.userId })
        .onConflictDoNothing({
          target: [ideaVotes.ideaId, ideaVotes.userId],
        });
      const updated = await this.hydrateIdea(tx, scope!, id);
      if (!updated) throw new IdeaError(`Unknown idea: ${id}`);
      return updated;
    });
  }

  async unvoteIdea(id: string, scope?: WorkspaceScope): Promise<IdeaRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const idea = await this.hydrateIdea(tx, scope!, id);
      if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
      await tx
        .delete(ideaVotes)
        .where(
          and(
            eq(ideaVotes.workspaceId, ws),
            eq(ideaVotes.ideaId, id),
            eq(ideaVotes.userId, scope!.userId),
          ),
        );
      const updated = await this.hydrateIdea(tx, scope!, id);
      if (!updated) throw new IdeaError(`Unknown idea: ${id}`);
      return updated;
    });
  }

  async promoteIdea(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const current = await tx.query.ideas.findFirst({
        where: and(eq(ideas.id, id), eq(ideas.workspaceId, ws)),
      });
      if (!current) throw new IdeaError(`Unknown idea: ${id}`);
      if (current.promotedFeatureId) {
        throw new IdeaError("This idea has already been promoted.");
      }
      const access = await this.accessIn(tx, scope!);
      const productId = current.productId ?? (await this.defaultProductId(tx, ws));
      if (!canWriteProductId(access, productId)) {
        throw new IdeaError("Your role does not permit promoting this idea.");
      }
      // Promote into the deepest non-leaf (planning) level; leaf items come from
      // specs, so a hierarchy with only a leaf can't accept a promotion.
      const levels = await this.levelsIn(tx, ws);
      const target = [...levels].reverse().find((l) => !l.isLeaf);
      if (!target) {
        throw new IdeaError(
          "This workspace has no non-leaf level to promote an idea into.",
        );
      }
      const featureId = randomUUID();
      const [featureRow] = await tx
        .insert(features)
        .values({
          id: featureId,
          workspaceId: ws,
          repoId: null,
          productId,
          specId: featureId,
          level: target.key,
          title: current.title,
          status: "backlog",
          details: current.description?.trim() ? current.description : null,
          parentId: null,
        })
        .returning();
      if (!featureRow) throw new IdeaError("Failed to create the feature.");

      const stages = await this.ideaStagesIn(tx, ws);
      await tx
        .update(ideas)
        .set({
          promotedFeatureId: featureId,
          status: promotedIdeaStatus(current.status, stages),
          updatedAt: new Date(),
        })
        .where(and(eq(ideas.id, id), eq(ideas.workspaceId, ws)));

      const idea = await this.hydrateIdea(tx, scope!, id);
      if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
      const feature: FeatureRecord = {
        specId: featureRow.specId,
        title: featureRow.title,
        level: featureRow.level,
        isDbNative: true,
        productId: featureRow.productId,
        status: featureRow.status,
        rank: featureRow.rank,
        tags: featureRow.tags,
        releaseId: featureRow.releaseId,
        assigneeId: featureRow.assigneeId,
        customFields: toCustomFields(featureRow.customFields),
        path: "",
        blocksCount: 0,
        blockedByCount: 0,
        parentSpecId: null,
        childCount: 0,
        childDoneCount: 0,
        githubSummary: emptyAgg(),
      };
      return { idea, feature };
    });
  }

  /** Resolve the effective idea review stages for a workspace (custom or default). */
  private async ideaStagesIn(tx: Tx, ws: string): Promise<readonly IdeaStage[]> {
    const rows = await tx
      .select()
      .from(ideaStatuses)
      .where(eq(ideaStatuses.workspaceId, ws))
      .orderBy(asc(ideaStatuses.position));
    return resolveIdeaStages(
      rows.map((r) => ({ key: r.key, label: r.label, position: r.position })),
    );
  }

  async listIdeaStatuses(scope?: WorkspaceScope): Promise<IdeaStage[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(ideaStatuses)
        .where(eq(ideaStatuses.workspaceId, scope!.workspaceId))
        .orderBy(asc(ideaStatuses.position));
      return rows.map((r) => ({
        key: r.key,
        label: r.label,
        position: r.position,
      }));
    });
  }

  async replaceIdeaStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
  ): Promise<IdeaStage[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const keys = stages.map((s) => s.key);
      const fallback = keys[0]!;
      const validKeys = new Set(keys);
      // Re-home any idea whose status is no longer a stage.
      const used = await tx
        .selectDistinct({ status: ideas.status })
        .from(ideas)
        .where(eq(ideas.workspaceId, ws));
      const orphaned = used.map((u) => u.status).filter((s) => !validKeys.has(s));
      if (orphaned.length > 0) {
        await tx
          .update(ideas)
          .set({ status: fallback, updatedAt: new Date() })
          .where(
            and(eq(ideas.workspaceId, ws), inArray(ideas.status, orphaned)),
          );
      }
      await tx.delete(ideaStatuses).where(eq(ideaStatuses.workspaceId, ws));
      if (stages.length > 0) {
        await tx.insert(ideaStatuses).values(
          stages.map((s, i) => ({
            workspaceId: ws,
            key: s.key,
            label: s.label,
            position: i,
          })),
        );
      }
      return stages.map((s, i) => ({ key: s.key, label: s.label, position: i }));
    });
  }

  async getIdeaSettings(scope?: WorkspaceScope): Promise<IdeaSettings> {
    return this.scoped(scope, async (tx) => {
      const row = await tx.query.ideaSettings.findFirst({
        where: eq(ideaSettings.workspaceId, scope!.workspaceId),
      });
      return {
        portalEnabled: row?.portalEnabled ?? false,
        portalTitle: row?.portalTitle ?? null,
      };
    });
  }

  async updateIdeaSettings(
    patch: IdeaSettingsPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaSettings> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const current = await tx.query.ideaSettings.findFirst({
        where: eq(ideaSettings.workspaceId, ws),
      });
      const next = {
        portalEnabled: patch.portalEnabled ?? current?.portalEnabled ?? false,
        portalTitle:
          patch.portalTitle !== undefined
            ? patch.portalTitle?.trim()
              ? patch.portalTitle.trim()
              : null
            : (current?.portalTitle ?? null),
      };
      await tx
        .insert(ideaSettings)
        .values({ workspaceId: ws, ...next, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: ideaSettings.workspaceId,
          set: { ...next, updatedAt: new Date() },
        });
      return next;
    });
  }

  // ── Products ────────────────────────────────────────────────────────────

  /** The workspace's default product id, creating it if it's somehow missing. */
  private async defaultProductId(tx: Tx, ws: string): Promise<string> {
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
  private async requireProductId(
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
  private async accessIn(
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
    return { isOrgAdmin: membership[0]?.role === "admin", roles };
  }

  /** Product visibility by id for owner-connection app-side RLS mirroring. */
  private async productVisibilityIn(
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
      return {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        position: row.position,
        color: row.color,
        itemCount: 0,
        viewerRole: null,
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
            "Only an organization admin can change a product's visibility.",
          );
        }
        set.visibility = patch.visibility;
      }
      if (patch.position !== undefined) set.position = patch.position;
      if (patch.color !== undefined) set.color = patch.color;
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

/** Normalize a workspace_properties row into the UI's PropertyDef. */
function toPropertyDef(row: {
  id: string;
  key: string;
  label: string;
  type: string;
  options: unknown;
  levels: unknown;
  position: number;
}): PropertyDef {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type as PropertyDef["type"],
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    levels: Array.isArray(row.levels) ? (row.levels as string[]) : null,
    position: row.position,
  };
}

/** Options only make sense for select/multiselect; other types store none. */
function normalizeOptions(
  type: PropertyDef["type"],
  options: string[] | undefined,
): string[] {
  if (type !== "select" && type !== "multiselect") return [];
  return [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
}

function normalizeReleaseStatus(status: string | undefined): ReleaseStatus {
  if (status === undefined) return "planned";
  if (!(RELEASE_STATUSES as readonly string[]).includes(status)) {
    throw new ReleaseError(`Unknown release status: ${status}`);
  }
  return status as ReleaseStatus;
}

function toReleaseRecord(
  row: {
    id: string;
    name: string;
    status: string;
    startDate: string | null;
    targetDate: string | null;
    notes: string | null;
  },
  itemCount: number,
): ReleaseRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status as ReleaseStatus,
    startDate: row.startDate,
    targetDate: row.targetDate,
    notes: row.notes,
    itemCount,
  };
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
