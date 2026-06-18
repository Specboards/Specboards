import type { SpecSection, WorkspaceLevel } from "@specboard/core";

export type { WorkspaceLevel };

/** A value stored for a team-defined custom field (see RepoConfig.fields). */
export type CustomFieldValue = string | number | boolean | string[] | null;

/** A feature as the UI consumes it: spec identity + PM metadata. */
export interface FeatureRecord {
  /** Stable spec id (frontmatter `id`) — also the route param. */
  specId: string;
  title: string;
  kind?: string;
  /**
   * Hierarchy level key (see WorkspaceLevel). Spec-backed rows are the leaf
   * level; DB-native initiatives/epics take a higher level.
   */
  level: string;
  /** True for DB-native items (initiatives/epics) — no repo/spec backing. */
  isDbNative: boolean;
  status: string;
  priority: number | null;
  /** Effort estimate in points (against RepoConfig.estimate.scale), or null. */
  estimate: number | null;
  /** Fractional/lexical rank for manual board ordering; null until first dragged. */
  rank: string | null;
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
  /** GitHub link counts rolled up over this feature's subtree (board badge). */
  githubSummary: GithubLinkAggregate;
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

export type GithubLinkKind = "pull_request" | "issue" | "branch";

/** A GitHub link as the UI sees it, resolved to a feature's perspective. */
export interface GithubLink {
  /** Opaque link id used to delete it. */
  id: string;
  kind: GithubLinkKind;
  /** PR/issue number, or null for a branch. */
  number: number | null;
  /** Branch name, or null for a PR/issue. */
  branch: string | null;
  url: string;
  title: string | null;
  /** Cached state: open / closed / merged; null for a branch. */
  state: string | null;
  /** The item the link is stored on (the spec it implements). */
  sourceSpecId: string;
  sourceTitle: string;
  /** True when rolled up from a descendant (vs a direct link on this item). */
  inherited: boolean;
}

/** Rolled-up GitHub link counts over a feature's subtree (for board badges). */
export interface GithubLinkAggregate {
  openPrs: number;
  mergedPrs: number;
  issues: number;
  branches: number;
  total: number;
}

/** What the user supplies to create a link; metadata is resolved server-side. */
export interface GithubLinkInput {
  kind: GithubLinkKind;
  number?: number | null;
  branch?: string | null;
}

/** A link with its GitHub metadata already resolved, ready to persist. */
export interface ResolvedGithubLink {
  repoId: string;
  kind: GithubLinkKind;
  number: number | null;
  branch: string | null;
  url: string;
  title: string | null;
  state: string | null;
}

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
  /** GitHub links: direct on this item + rolled up from descendants. */
  githubLinks: GithubLink[];
}

export type FeaturePatch = Partial<
  Pick<
    FeatureRecord,
    | "title"
    | "status"
    | "priority"
    | "estimate"
    | "rank"
    | "tags"
    | "roadmapQuarter"
    | "assigneeId"
    | "customFields"
    | "parentSpecId"
  >
>;

/**
 * Fields to create a DB-native work item (an initiative/epic — a non-leaf
 * level). Leaf items come from git/spec sync, not this path. `level` must be a
 * non-leaf level and `parentSpecId`, when set, the level immediately above.
 */
export interface CreateFeatureInput {
  title: string;
  level: string;
  parentSpecId?: string | null;
  status?: string;
  priority?: number | null;
  estimate?: number | null;
  assigneeId?: string | null;
  roadmapQuarter?: string | null;
  tags?: string[];
}

/**
 * One level in a hierarchy-config update, ordered top → leaf in the array.
 * `key` names an existing level to keep (label may change); omit it for a
 * newly-added level (the store generates a stable key from the label).
 */
export interface LevelUpdate {
  key?: string;
  label: string;
}

/** Raised when a work item can't be created/deleted (bad level, has a spec, …). */
export class FeatureError extends Error {}

/** Raised when a hierarchy-level config update is invalid or unsafe. */
export class LevelError extends Error {}

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

/** Serialized backlog filter bundle persisted with a saved view. */
export type SavedViewFilters = Record<string, string | number>;

/** A user's named, saved backlog filter ("custom view"). */
export interface SavedView {
  id: string;
  name: string;
  /** Which list it applies to (currently always "backlog"). */
  view: string;
  filters: SavedViewFilters;
}

/** Fields needed to create a saved view (id/createdAt are assigned by the store). */
export interface SavedViewInput {
  name: string;
  view: string;
  filters: SavedViewFilters;
}

/**
 * A user's personal board display preferences: which field keys render on a
 * card (ordered) and which custom field is featured. `cardFields: null` means
 * "use the default set"; an empty array means "show no badges".
 */
export interface BoardPreferences {
  cardFields: string[] | null;
  /** Custom-field key (no `cf:` prefix) to emphasize on the card, or null. */
  featured: string | null;
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
  /** The workspace's hierarchy levels, ordered top → leaf. */
  listLevels(scope?: WorkspaceScope): Promise<WorkspaceLevel[]>;
  /**
   * Replace the workspace's hierarchy level configuration. The leaf (deepest)
   * level key is fixed (spec-backed); a removed level must have no items.
   * Returns the resolved, ordered levels after the update.
   */
  updateLevels(
    levels: LevelUpdate[],
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]>;
  /** Create a DB-native work item (initiative/epic). Returns the new record. */
  createFeature(
    input: CreateFeatureInput,
    scope?: WorkspaceScope,
  ): Promise<FeatureRecord>;
  /** Delete a DB-native work item by id. Spec-backed items can't be deleted here. */
  deleteFeature(specId: string, scope?: WorkspaceScope): Promise<void>;
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
  /** Persist a resolved GitHub link on the feature `specId`. */
  addGithubLink(
    specId: string,
    link: ResolvedGithubLink,
    scope?: WorkspaceScope,
  ): Promise<void>;
  /** Remove a GitHub link by its opaque id. */
  removeGithubLink(
    specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void>;
  /** The acting user's saved backlog views (personal, newest first). */
  listSavedViews(scope?: WorkspaceScope): Promise<SavedView[]>;
  /** Persist a new saved view for the acting user; returns it with its id. */
  createSavedView(
    input: SavedViewInput,
    scope?: WorkspaceScope,
  ): Promise<SavedView>;
  /** Delete one of the acting user's saved views by id. */
  deleteSavedView(id: string, scope?: WorkspaceScope): Promise<void>;
  /** The acting user's board preferences, or null when none are saved. */
  getBoardPreferences(scope?: WorkspaceScope): Promise<BoardPreferences | null>;
  /** Persist the acting user's board preferences (upsert). */
  setBoardPreferences(
    prefs: BoardPreferences,
    scope?: WorkspaceScope,
  ): Promise<void>;
}

/** Raised when a relation can't be created (self-link, cycle, unknown target). */
export class RelationError extends Error {}
