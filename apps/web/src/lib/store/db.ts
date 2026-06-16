import { extractSections } from "@specboard/core";
import {
  and,
  createDb,
  eq,
  featureLinks,
  features,
  inArray,
  or,
  sql,
  specIndex,
  users,
  type Database,
} from "@specboard/db";

import {
  RelationError,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureRelation,
  type FeatureStore,
  type RelationDirection,
  type RelationInput,
  type WorkspaceScope,
} from "./types";

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

/** Normalize the jsonb custom-fields column into the UI's value map. */
function toCustomFields(value: unknown): Record<string, CustomFieldValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, CustomFieldValue>)
    : {};
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
      return rows.map((row) => ({
        specId: row.specId,
        title: row.title,
        status: row.status,
        priority: row.priority,
        tags: row.tags,
        roadmapQuarter: row.roadmapQuarter,
        assigneeId: row.assigneeId,
        customFields: toCustomFields(row.customFields),
        path: row.index?.path ?? "",
        blocksCount: blocks.get(row.id) ?? 0,
        blockedByCount: blockedBy.get(row.id) ?? 0,
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

      return {
        specId: row.specId,
        title: row.title,
        status: row.status,
        priority: row.priority,
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
      };
    });
  }

  async updateFeature(
    specId: string,
    patch: FeaturePatch,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      await tx
        .update(features)
        .set({ ...patch, updatedAt: new Date() })
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
