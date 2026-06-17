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
  /** Effort estimate in points (against RepoConfig.estimate.scale), or null. */
  estimate: number | null;
  /**
   * Estimate rolled up over this feature's subtree (itself + all descendants).
   * Equals `estimate` for a leaf; null when nothing in the subtree is estimated.
   */
  rolledEstimate: number | null;
  tags: string[];
  roadmapQuarter: string | null;
  /** Assigned user id, or null when unassigned. */
  assigneeId: string | null;
  /** Values keyed by custom-field key (see RepoConfig.fields). */
  customFields: Record<string, CustomFieldValue>;
  /** Spec path relative to the repo root. */
  path: string;
  /** Number of features that block this one (drives the "blocked" badge). */
  blockedByCount: number;
  /** Number of features this one blocks. */
  blocksCount: number;
  /** Parent feature (epic) spec id, or null when top-level. */
  parentSpecId: string | null;
  /** Direct children count (this feature is an epic when > 0). */
  childCount: number;
  /** Direct children that are done (for roll-up progress). */
  childDoneCount: number;
}

/** A child feature summarized on its parent's detail view. */
export interface ChildRef {
  specId: string;
  title: string;
  status: string;
}

/**
 * A typed relation as seen from one feature's perspective. `direction` already
 * resolves the stored edge into the viewer's point of view (e.g. a stored
 * `blocks` edge pointing *at* this feature surfaces as `blocked_by`).
 */
export type RelationDirection =
  | "blocks"
  | "blocked_by"
  | "relates_to"
  | "duplicates"
  | "duplicated_by";

/** The directions a user can create (the inverse "_by" forms are derived). */
export const RELATION_DIRECTIONS = [
  "blocks",
  "blocked_by",
  "relates_to",
  "duplicates",
] as const;
export type CreatableRelationDirection = (typeof RELATION_DIRECTIONS)[number];

export interface FeatureRelation {
  /** Opaque link id used to delete the relation (uuid in db mode). */
  id: string;
  direction: RelationDirection;
  /** The feature on the other end of the relation. */
  otherSpecId: string;
  otherTitle: string;
}

export interface RelationInput {
  toSpecId: string;
  direction: CreatableRelationDirection;
}

export interface FeatureDetail extends FeatureRecord {
  /** Display name of the assignee, resolved from the user record (db store). */
  assigneeName: string | null;
  /** Spec markdown with frontmatter stripped. */
  content: string;
  sections: SpecSection[];
  /** Typed relations to other features, from this feature's perspective. */
  relations: FeatureRelation[];
  /** Title of the parent feature, or null when top-level. */
  parentTitle: string | null;
  /** Direct children of this feature (epic contents). */
  children: ChildRef[];
}

export type FeaturePatch = Partial<
  Pick<
    FeatureRecord,
    | "status"
    | "priority"
    | "estimate"
    | "tags"
    | "roadmapQuarter"
    | "assigneeId"
    | "customFields"
    | "parentSpecId"
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
  /** Create a typed relation from `specId` to another feature. */
  addRelation(
    specId: string,
    input: RelationInput,
    scope?: WorkspaceScope,
  ): Promise<void>;
  /** Remove a relation by its opaque id (as returned in FeatureRelation.id). */
  removeRelation(
    specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void>;
}

/** Raised when a relation can't be created (self-link, cycle, unknown target). */
export class RelationError extends Error {}
