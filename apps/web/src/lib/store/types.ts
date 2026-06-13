import type { SpecSection } from "@specboard/core";

/** A value stored for a team-defined custom field (see RepoConfig.fields). */
export type CustomFieldValue = string | number | boolean | string[] | null;

/** A feature as the UI consumes it: spec identity + PM metadata. */
export interface FeatureRecord {
  /** Stable spec id (frontmatter `id`) — also the route param. */
  specId: string;
  title: string;
  kind?: string;
  status: string;
  priority: number | null;
  tags: string[];
  roadmapQuarter: string | null;
  /** Assigned user id, or null when unassigned. */
  assigneeId: string | null;
  /** Values keyed by custom-field key (see RepoConfig.fields). */
  customFields: Record<string, CustomFieldValue>;
  /** Spec path relative to the repo root. */
  path: string;
}

export interface FeatureDetail extends FeatureRecord {
  /** Display name of the assignee, resolved from the user record (db store). */
  assigneeName: string | null;
  /** Spec markdown with frontmatter stripped. */
  content: string;
  sections: SpecSection[];
}

export type FeaturePatch = Partial<
  Pick<
    FeatureRecord,
    "status" | "priority" | "tags" | "roadmapQuarter" | "assigneeId" | "customFields"
  >
>;

/**
 * Per-request tenant context. Carries the acting user and their workspace so
 * the DB store can both filter rows by `workspaceId` and set the `app.user_id`
 * session variable that RLS keys on. `undefined` only in local file mode,
 * where there is a single implicit workspace.
 */
export interface WorkspaceScope {
  userId: string;
  workspaceId: string;
}

/**
 * Storage boundary for the web app. Two implementations:
 * - `local`: reads specs from the filesystem, metadata in a JSON file —
 *   zero-setup local testing (scope ignored; single implicit workspace).
 * - `db`: Drizzle/Postgres (`DATABASE_URL`) — the real deployment shape;
 *   requires a `scope` and isolates every query to it.
 */
export interface FeatureStore {
  listFeatures(scope?: WorkspaceScope): Promise<FeatureRecord[]>;
  getFeature(specId: string, scope?: WorkspaceScope): Promise<FeatureDetail | null>;
  updateFeature(
    specId: string,
    patch: FeaturePatch,
    scope?: WorkspaceScope,
  ): Promise<void>;
}
