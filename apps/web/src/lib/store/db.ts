import { randomUUID } from "node:crypto";

import {
  extractSections,
  isLeafLevel,
  isValidParentLevel,
  resolveLevels,
  resolveLevelUpdate,
  rollUpEstimates,
  type WorkspaceLevel,
} from "@specboard/core";
import {
  and,
  asc,
  boardPreferences,
  createDb,
  desc,
  eq,
  featureGithubLinks,
  featureLinks,
  features,
  inArray,
  or,
  savedViews,
  sql,
  specIndex,
  users,
  workspaceLevels,
  type Database,
} from "@specboard/db";

import {
  FeatureError,
  LevelError,
  RelationError,
  type BoardPreferences,
  type CreateFeatureInput,
  type LevelUpdate,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureRelation,
  type FeatureStore,
  type GithubLink,
  type GithubLinkAggregate,
  type GithubLinkKind,
  type RelationDirection,
  type RelationInput,
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

/** Postgres-backed store (self-host compose stack or managed Postgres). */
export class DbStore implements FeatureStore {
  private readonly db: Database;

  constructor(connectionString: string) {
    this.db = createDb(connectionString);
  }

  /**
   * Run `fn` inside a transaction scoped to `scope`: it sets the
   * `app.user_id` session variable RLS keys on (transaction-local, so it must
   * live in a transaction), and callers additionally filter by `workspaceId`.
   * Refuses to run unscoped — that would expose every tenant's rows, since the
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
      await tx.execute(sql`select set_config('app.user_id', ${scope.userId}, true)`);
      return fn(tx);
    });
  }

  async listFeatures(scope?: WorkspaceScope): Promise<FeatureRecord[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx.query.features.findMany({
        where: eq(features.workspaceId, scope!.workspaceId),
        with: { index: true },
      });
      // One pass over the workspace's `blocks` edges to tally counts per row.
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
      const blocks = new Map<string, number>();
      const blockedBy = new Map<string, number>();
      for (const l of links) {
        blocks.set(l.fromFeatureId, (blocks.get(l.fromFeatureId) ?? 0) + 1);
        blockedBy.set(l.toFeatureId, (blockedBy.get(l.toFeatureId) ?? 0) + 1);
      }
      // Hierarchy roll-up from the full workspace set (no extra query).
      const specById = new Map(rows.map((r) => [r.id, r.specId]));
      const childCount = new Map<string, number>();
      const childDone = new Map<string, number>();
      for (const r of rows) {
        if (!r.parentId) continue;
        childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
        if (isDone(r.status))
          childDone.set(r.parentId, (childDone.get(r.parentId) ?? 0) + 1);
      }
      const rolled = rollUpEstimates(
        rows.map((r) => ({
          key: r.id,
          parentKey: r.parentId,
          estimate: r.estimate,
        })),
      );
      // GitHub link aggregate, rolled up over each feature's subtree. Tally each
      // link onto its own feature, then propagate up the parent chain.
      const ghLinks = await tx
        .select({
          featureId: featureGithubLinks.featureId,
          kind: featureGithubLinks.kind,
          state: featureGithubLinks.state,
        })
        .from(featureGithubLinks)
        .where(eq(featureGithubLinks.workspaceId, scope!.workspaceId));
      const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
      const ghAgg = new Map<string, GithubLinkAggregate>();
      for (const r of rows) ghAgg.set(r.id, emptyAgg());
      for (const link of ghLinks) {
        // Add this link to its own feature and every ancestor (subtree roll-up).
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
        status: row.status,
        priority: row.priority,
        estimate: row.estimate,
        rolledEstimate: rolled.get(row.id) ?? null,
        rank: row.rank,
        tags: row.tags,
        roadmapQuarter: row.roadmapQuarter,
        assigneeId: row.assigneeId,
        customFields: toCustomFields(row.customFields),
        path: row.index?.path ?? "",
        blocksCount: blocks.get(row.id) ?? 0,
        blockedByCount: blockedBy.get(row.id) ?? 0,
        parentSpecId: row.parentId ? (specById.get(row.parentId) ?? null) : null,
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
      const content = row.index?.content ?? "";
      // Resolve the assignee's display name (separate lookup — there's no
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
            })
            .from(features)
            .where(inArray(features.id, otherIds))
        : [];
      const byId = new Map(others.map((o) => [o.id, o]));
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
          } satisfies FeatureRelation;
        })
        .filter((r): r is FeatureRelation => r !== null);

      // Parent (one lookup) + direct children for the hierarchy view.
      let parentSpecId: string | null = null;
      let parentTitle: string | null = null;
      if (row.parentId) {
        const parent = await tx.query.features.findFirst({
          where: eq(features.id, row.parentId),
          columns: { specId: true, title: true },
        });
        parentSpecId = parent?.specId ?? null;
        parentTitle = parent?.title ?? null;
      }
      const childRows = await tx
        .select({
          specId: features.specId,
          title: features.title,
          status: features.status,
        })
        .from(features)
        .where(eq(features.parentId, row.id));

      // Roll the estimate up over this feature's subtree. Needs the whole
      // workspace tree, so pull just the three columns the roll-up uses.
      const estimateRows = await tx
        .select({
          id: features.id,
          parentId: features.parentId,
          estimate: features.estimate,
        })
        .from(features)
        .where(eq(features.workspaceId, scope!.workspaceId));
      const rolled = rollUpEstimates(
        estimateRows.map((r) => ({
          key: r.id,
          parentKey: r.parentId,
          estimate: r.estimate,
        })),
      );

      // GitHub links: this item's own + all descendants' (rolled up). Walk the
      // parent map down from `row.id` to collect the subtree feature ids.
      const childrenOf = new Map<string, string[]>();
      for (const r of estimateRows) {
        if (!r.parentId) continue;
        (childrenOf.get(r.parentId) ?? childrenOf.set(r.parentId, []).get(r.parentId)!).push(r.id);
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
            .select({ id: features.id, specId: features.specId, title: features.title })
            .from(features)
            .where(inArray(features.id, [...new Set(ghRows.map((l) => l.featureId))]))
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
        status: row.status,
        priority: row.priority,
        estimate: row.estimate,
        rolledEstimate: rolled.get(row.id) ?? null,
        rank: row.rank,
        tags: row.tags,
        roadmapQuarter: row.roadmapQuarter,
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
  private async levelsIn(tx: Tx, workspaceId: string): Promise<WorkspaceLevel[]> {
    const rows = await tx
      .select({
        key: workspaceLevels.key,
        label: workspaceLevels.label,
        position: workspaceLevels.position,
        isLeaf: workspaceLevels.isLeaf,
      })
      .from(workspaceLevels)
      .where(eq(workspaceLevels.workspaceId, workspaceId))
      .orderBy(asc(workspaceLevels.position));
    return resolveLevels(rows);
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
        throw new LevelError(err instanceof Error ? err.message : "Invalid levels.");
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
          })
          .onConflictDoUpdate({
            target: [workspaceLevels.workspaceId, workspaceLevels.key],
            set: {
              label: level.label,
              position: level.position,
              isLeaf: level.isLeaf,
            },
          });
      }
      return resolved.levels;
    });
  }

  async createFeature(
    input: CreateFeatureInput,
    scope?: WorkspaceScope,
  ): Promise<FeatureRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const levels = await this.levelsIn(tx, ws);

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
          .select({ id: features.id, level: features.level })
          .from(features)
          .where(
            and(
              eq(features.specId, input.parentSpecId),
              eq(features.workspaceId, ws),
            ),
          );
        if (!parent[0])
          throw new FeatureError(`Unknown parent: ${input.parentSpecId}`);
        if (!isValidParentLevel(input.level, parent[0].level, levels))
          throw new FeatureError(
            `A ${input.level} can't sit under a ${parent[0].level}.`,
          );
        parentId = parent[0].id;
      } else if (!isValidParentLevel(input.level, null, levels)) {
        throw new FeatureError(`A ${input.level} requires a parent.`);
      }

      // DB-native items have no repo/spec; spec_id mirrors the row id so every
      // row stays uniformly routable by specId.
      const id = randomUUID();
      const [row] = await tx
        .insert(features)
        .values({
          id,
          workspaceId: ws,
          repoId: null,
          specId: id,
          level: input.level,
          title,
          status: input.status ?? "backlog",
          priority: input.priority ?? null,
          estimate: input.estimate ?? null,
          assigneeId: input.assigneeId ?? null,
          roadmapQuarter: input.roadmapQuarter ?? null,
          tags: input.tags ?? [],
          parentId,
        })
        .returning();
      if (!row) throw new FeatureError("Failed to create work item.");

      return {
        specId: row.specId,
        title: row.title,
        level: row.level,
        isDbNative: true,
        status: row.status,
        priority: row.priority,
        estimate: row.estimate,
        rolledEstimate: row.estimate,
        rank: row.rank,
        tags: row.tags,
        roadmapQuarter: row.roadmapQuarter,
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

  async deleteFeature(specId: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const row = await tx
        .select({ id: features.id, repoId: features.repoId })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
      if (!row[0]) throw new FeatureError(`Unknown work item: ${specId}`);
      if (row[0].repoId !== null)
        throw new FeatureError(
          "Spec-backed items can't be deleted here — remove the spec in git.",
        );
      // Children's parent_id is ON DELETE SET NULL, so they're orphaned, not deleted.
      await tx
        .delete(features)
        .where(and(eq(features.id, row[0].id), eq(features.workspaceId, ws)));
    });
  }

  async updateFeature(
    specId: string,
    patch: FeaturePatch,
    scope?: WorkspaceScope,
  ): Promise<void> {
    // `parentSpecId` isn't a column — translate it to the parent row's `parentId`.
    const { parentSpecId, ...rest } = patch;
    await this.scoped(scope, async (tx) => {
      const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
      if (parentSpecId !== undefined) {
        if (parentSpecId === null) {
          set.parentId = null;
        } else {
          const parent = await tx
            .select({ id: features.id })
            .from(features)
            .where(
              and(
                eq(features.specId, parentSpecId),
                eq(features.workspaceId, scope!.workspaceId),
              ),
            );
          if (!parent[0])
            throw new RelationError(`Unknown parent feature: ${parentSpecId}`);
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
        .select({ id: features.id, specId: features.specId })
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
    _specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
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
        .select({ id: features.id })
        .from(features)
        .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
      if (!feat[0]) throw new RelationError(`Unknown feature: ${specId}`);
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
    _specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
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
      return { fromFeatureId: selfId, toFeatureId: otherId, type: "relates_to" };
    case "duplicates":
      return { fromFeatureId: selfId, toFeatureId: otherId, type: "duplicates" };
  }
}

export { specIndex };
