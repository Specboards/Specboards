import { extractSections } from "@specboard/core";
import {
  and,
  createDb,
  eq,
  features,
  sql,
  specIndex,
  users,
  type Database,
} from "@specboard/db";

import type {
  CustomFieldValue,
  FeatureDetail,
  FeaturePatch,
  FeatureRecord,
  FeatureStore,
  WorkspaceScope,
} from "./types";

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
}

export { specIndex };
