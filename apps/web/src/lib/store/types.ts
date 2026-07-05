import type {
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
  IdeaStage,
  ProductAccess,
  ProductRole,
  ProductVisibility,
  PropertyDef,
  PropertyType,
  SpecSection,
  WorkspaceLevel,
} from "@specboard/core";

export type {
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
  IdeaStage,
  ProductAccess,
  ProductRole,
  ProductVisibility,
  PropertyDef,
  PropertyType,
  WorkspaceLevel,
};

/** Raised when a detail template can't be created/updated/deleted. */
export class DetailTemplateError extends Error {}

/** A value stored for an admin-defined custom property (see PropertyDef). */
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
  /** Owning product (sibling backlog), or null for legacy/unassigned rows. */
  productId: string | null;
  status: string;
  /** Fractional/lexical rank for manual board ordering; null until first dragged. */
  rank: string | null;
  tags: string[];
  /** Owning release, or null when unscheduled. */
  releaseId: string | null;
  /** Assigned user id, or null when unassigned. */
  assigneeId: string | null;
  /** Values keyed by custom-property key (see PropertyDef). */
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
  /** The other feature's level key, for building its typed permalink. */
  otherLevel: string;
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
    | "rank"
    | "tags"
    | "releaseId"
    | "assigneeId"
    | "customFields"
    | "parentSpecId"
  >
> & {
  /** Markdown body for a DB-native item; ignored for spec-backed items. */
  details?: string | null;
};

/**
 * Fields to create a DB-native work item (an initiative/epic — a non-leaf
 * level). Leaf items come from git/spec sync, not this path. `level` must be a
 * non-leaf level and `parentSpecId`, when set, the level immediately above.
 */
export interface CreateFeatureInput {
  title: string;
  level: string;
  /** Owning product; defaults to the workspace's default product when omitted. */
  productId?: string | null;
  parentSpecId?: string | null;
  status?: string;
  assigneeId?: string | null;
  tags?: string[];
  /** Markdown body for the new DB-native item, or null/omitted for a blank body. */
  details?: string | null;
}

/** A product (sibling backlog) as the UI consumes it. */
export interface ProductRecord {
  id: string;
  /** Stable slug used in the `?product=` URL. */
  key: string;
  name: string;
  description: string | null;
  visibility: ProductVisibility;
  position: number;
  /** Accent-color token, or null to derive one from the key (see core
   * `resolveProductColor`). */
  color: string | null;
  /** Count of work items in this product. */
  itemCount: number;
  /** The acting user's explicit role on this product, or null (org admins
   * implicitly manage all — see PageAccess.role). */
  viewerRole: ProductRole | null;
}

export interface CreateProductInput {
  name: string;
  description?: string | null;
  visibility?: ProductVisibility;
  color?: string | null;
}

export type ProductPatch = Partial<{
  name: string;
  description: string | null;
  visibility: ProductVisibility;
  position: number;
  color: string | null;
}>;

/** A user's membership of one product, joined to their identity. */
export interface ProductMemberRecord {
  userId: string;
  name: string;
  email: string;
  role: ProductRole;
}

export interface ProductMemberInput {
  userId: string;
  role: ProductRole;
}

/** Raised when a product can't be created/updated/deleted (in use, dup, …). */
export class ProductError extends Error {}

/**
 * One level in a hierarchy-config update, ordered top → leaf in the array.
 * `key` names an existing level to keep (label may change); omit it for a
 * newly-added level (the store generates a stable key from the label).
 */
export interface LevelUpdate {
  key?: string;
  label: string;
}

/** Fields to create a custom property; key/position are assigned by the store. */
export interface PropertyInput {
  label: string;
  type: PropertyType;
  options?: string[];
  /** Level keys the property applies to; null/omitted = every level. */
  levels?: string[] | null;
}

export type PropertyPatch = Partial<{
  label: string;
  options: string[];
  levels: string[] | null;
  position: number;
}>;

/** Raised when a property can't be created/updated/deleted. */
export class PropertyError extends Error {}

/** An admin-defined workflow stage as the UI consumes it. */
export interface WorkspaceStatus {
  /** Stable slug stored in `features.status`. */
  key: string;
  /** Editable display name (renaming changes only this, not the key). */
  label: string;
  /** Board column / ordering position; ascending. */
  position: number;
}

/** One stage in a workflow-replacement request. */
export interface StatusStageInput {
  key: string;
  label: string;
}

/** A stage gate (one checklist item on a workflow stage) as the UI consumes it. */
export interface StageGate {
  /** Opaque id used to toggle completions and to reorder/remove the gate. */
  id: string;
  /** The stage key this gate guards (a WorkspaceStatus.key or built-in key). */
  stageKey: string;
  label: string;
  /** Ordering within the stage's checklist; ascending. */
  position: number;
}

/** One gate in a stage-gates replacement request (id omitted = newly added). */
export interface StageGateInput {
  /** Existing gate id to keep (preserves its completions); omit for a new gate. */
  id?: string;
  stageKey: string;
  label: string;
}

/** Raised when stage gates can't be replaced (bad stage key, empty label, …). */
export class StageGateError extends Error {}

export type ReleaseStatus = "planned" | "in_progress" | "shipped";

export const RELEASE_STATUSES: readonly ReleaseStatus[] = [
  "planned",
  "in_progress",
  "shipped",
];

/** A release (ship vehicle) as the UI consumes it. */
export interface ReleaseRecord {
  id: string;
  name: string;
  status: ReleaseStatus;
  /** Planned start date as YYYY-MM-DD, or null when unset. */
  startDate: string | null;
  /** Target ship date as YYYY-MM-DD, or null when undated. */
  targetDate: string | null;
  /** Free-form release notes (Markdown), or null. */
  notes: string | null;
  /** Count of items scheduled into this release. */
  itemCount: number;
}

export interface ReleaseInput {
  name: string;
  status?: ReleaseStatus;
  startDate?: string | null;
  targetDate?: string | null;
  notes?: string | null;
}

export type ReleasePatch = Partial<{
  name: string;
  status: ReleaseStatus;
  startDate: string | null;
  targetDate: string | null;
  notes: string | null;
}>;

/** Raised when a release can't be created/updated/deleted. */
export class ReleaseError extends Error {}

/** Dated releases first (ascending target date), undated last, then by name. */
export function compareReleases(
  a: Pick<ReleaseRecord, "targetDate" | "name">,
  b: Pick<ReleaseRecord, "targetDate" | "name">,
): number {
  if (a.targetDate !== b.targetDate) {
    if (a.targetDate === null) return 1;
    if (b.targetDate === null) return -1;
    return a.targetDate < b.targetDate ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/** An idea / feature request as the UI consumes it. */
export interface IdeaRecord {
  id: string;
  title: string;
  /** Free-form detail (Markdown), or null. */
  description: string | null;
  /** Idea review stage key (see core DEFAULT_IDEA_STAGES). */
  status: string;
  /** Owning product id, or null when unassigned. */
  productId: string | null;
  /** Display name of the internal author, or null (external/portal submitter). */
  authorName: string | null;
  /** External submitter's name, or null for internal captures. */
  submitterName: string | null;
  /** Total votes (demand signal). */
  voteCount: number;
  /** Whether the acting user has voted for this idea. */
  viewerHasVoted: boolean;
  /** specId of the feature this idea was promoted into, or null. */
  promotedFeatureSpecId: string | null;
  /** Title of the promoted feature, or null when not promoted. */
  promotedFeatureTitle: string | null;
  createdAt: string;
}

export interface IdeaInput {
  title: string;
  description?: string | null;
  /** Owning product; defaults to the workspace's default product when omitted. */
  productId?: string | null;
}

export type IdeaPatch = Partial<{
  title: string;
  description: string | null;
  status: string;
  productId: string | null;
}>;

/** Per-workspace Ideas configuration (public portal settings). */
export interface IdeaSettings {
  portalEnabled: boolean;
  /** Portal heading, or null to fall back to the workspace name. */
  portalTitle: string | null;
}

export type IdeaSettingsPatch = Partial<{
  portalEnabled: boolean;
  portalTitle: string | null;
}>;

/** Raised when an idea can't be created/updated/deleted/promoted. */
export class IdeaError extends Error {}

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

/**
 * A domain event to record in the transactional outbox, written in the *same
 * transaction* as the change that produced it (so the event can never be lost
 * between the commit and a separate enqueue). `data` is an opaque snapshot the
 * outbox relay maps to consumer formats (today: a webhook envelope; later, e.g.
 * notifications). `productId` scopes routing (null = workspace-level). The store
 * fills `actorId`/`workspaceId` from the scope. `createFeature` is special-cased:
 * its `specId` is generated inside the write, so it takes just the event `type`
 * and builds `data` from the new row itself.
 */
export interface OutboxEmit {
  type: string;
  productId: string | null;
  data: Record<string, unknown>;
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
  /**
   * Set which metadata fields are available per level (keyed by level key;
   * null = all fields). Unlisted levels are left unchanged. Returns the
   * resolved levels after the update.
   */
  updateLevelFields(
    fields: Record<string, string[] | null>,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]>;
  /**
   * The workspace's admin-defined workflow stages, ordered by position, or `[]`
   * when the workspace uses the built-in default workflow.
   */
  listStatuses(scope?: WorkspaceScope): Promise<WorkspaceStatus[]>;
  /**
   * Replace the workspace's workflow stages. Items whose status is no longer a
   * stage (and isn't the system `archived` status) are moved to the first
   * stage. Returns the resolved, ordered stages after the update.
   */
  replaceStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
  ): Promise<WorkspaceStatus[]>;
  /**
   * The workspace's stage gates (checklist items per stage), ordered by stage
   * then position. `[]` when no gates are defined.
   */
  listStageGates(scope?: WorkspaceScope): Promise<StageGate[]>;
  /**
   * Replace the workspace's stage gates wholesale. Positions follow the given
   * order within each stage. Completions for removed gates are dropped (FK
   * cascade). Returns the resolved, ordered gates after the update.
   */
  replaceStageGates(
    gates: StageGateInput[],
    scope?: WorkspaceScope,
  ): Promise<StageGate[]>;
  /**
   * The gate ids completed (checked off) for one feature. Absence of an id
   * means that gate is still open for the item.
   */
  listGateCompletions(specId: string, scope?: WorkspaceScope): Promise<string[]>;
  /**
   * Mark a gate complete/incomplete for a feature (idempotent upsert/delete).
   * `completedBy` records who checked it, for a future audit trail.
   */
  setGateCompletion(
    specId: string,
    gateId: string,
    completed: boolean,
    scope?: WorkspaceScope,
  ): Promise<void>;
  /** The workspace's custom properties, ordered by position. */
  listProperties(scope?: WorkspaceScope): Promise<PropertyDef[]>;
  /** Create a custom property definition; returns it with its key/id. */
  createProperty(
    input: PropertyInput,
    scope?: WorkspaceScope,
  ): Promise<PropertyDef>;
  /** Update a property's label/options/levels/position (type is fixed). */
  updateProperty(
    id: string,
    patch: PropertyPatch,
    scope?: WorkspaceScope,
  ): Promise<PropertyDef>;
  /** Delete a property definition (stored item values are left in place). */
  deleteProperty(id: string, scope?: WorkspaceScope): Promise<void>;
  /** The workspace's detail templates, ordered by name. */
  listDetailTemplates(scope?: WorkspaceScope): Promise<DetailTemplate[]>;
  /** Create a detail template; returns the new record. */
  createDetailTemplate(
    input: DetailTemplateInput,
    scope?: WorkspaceScope,
  ): Promise<DetailTemplate>;
  /** Update a detail template's name/body. */
  updateDetailTemplate(
    id: string,
    patch: DetailTemplatePatch,
    scope?: WorkspaceScope,
  ): Promise<DetailTemplate>;
  /** Delete a detail template; levels pointing at it fall back to a blank body. */
  deleteDetailTemplate(id: string, scope?: WorkspaceScope): Promise<void>;
  /**
   * Assign a default detail template per level (keyed by level key; null clears
   * it). Unlisted levels are left unchanged. Returns the resolved levels.
   */
  updateLevelTemplates(
    templates: Record<string, string | null>,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]>;
  /** The workspace's releases, dated first (ascending), undated last. */
  listReleases(scope?: WorkspaceScope): Promise<ReleaseRecord[]>;
  /** Create a release; returns the new record. */
  createRelease(
    input: ReleaseInput,
    scope?: WorkspaceScope,
  ): Promise<ReleaseRecord>;
  /** Update a release's name/status/target date. `emit`, when given, records an
   * outbox event in the same transaction as the update. */
  updateRelease(
    id: string,
    patch: ReleasePatch,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
  ): Promise<ReleaseRecord>;
  /** Delete a release; its items are unscheduled, not deleted. */
  deleteRelease(id: string, scope?: WorkspaceScope): Promise<void>;
  /** The acting user's effective product access (org-admin flag + per-product
   * grants), used for read-filtering and write authorization. */
  getProductAccess(scope?: WorkspaceScope): Promise<ProductAccess>;
  /** Products (sibling backlogs) the acting user can see, ordered by position. */
  listProducts(scope?: WorkspaceScope): Promise<ProductRecord[]>;
  /** A single product by its key (the `?product=` slug), or null. */
  getProduct(key: string, scope?: WorkspaceScope): Promise<ProductRecord | null>;
  /** Create a product (org-admin action). Returns the new record. */
  createProduct(
    input: CreateProductInput,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord>;
  /** Update a product's settings. Returns the updated record. */
  updateProduct(
    id: string,
    patch: ProductPatch,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord>;
  /** Delete a product (must have no items). */
  deleteProduct(id: string, scope?: WorkspaceScope): Promise<void>;
  /** A product's members joined to their identities, ordered by name. */
  listProductMembers(
    productId: string,
    scope?: WorkspaceScope,
  ): Promise<ProductMemberRecord[]>;
  /** Add or update a user's role on a product (upsert). */
  setProductMember(
    productId: string,
    input: ProductMemberInput,
    scope?: WorkspaceScope,
  ): Promise<void>;
  /** Remove a user's membership of a product. */
  removeProductMember(
    productId: string,
    userId: string,
    scope?: WorkspaceScope,
  ): Promise<void>;
  /** Create a DB-native work item (initiative/epic). Returns the new record.
   * `emitType`, when given, records an outbox event of that type (with data built
   * from the new row) in the same transaction. */
  createFeature(
    input: CreateFeatureInput,
    scope?: WorkspaceScope,
    emitType?: string,
  ): Promise<FeatureRecord>;
  /** Delete a DB-native work item by id. Spec-backed items can't be deleted here.
   * `emit`, when given, records an outbox event in the same transaction. */
  deleteFeature(
    specId: string,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
  ): Promise<void>;
  /** `emit`, when given, records an outbox event in the same transaction. */
  updateFeature(
    specId: string,
    patch: FeaturePatch,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
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
  // ── Ideas ───────────────────────────────────────────────────────────────
  /** The workspace's ideas the acting user can see, most-voted first. */
  listIdeas(scope?: WorkspaceScope): Promise<IdeaRecord[]>;
  /** Capture a new idea; returns the new record. */
  createIdea(input: IdeaInput, scope?: WorkspaceScope): Promise<IdeaRecord>;
  /** Update an idea's title/description/status/product. Returns the record. */
  updateIdea(
    id: string,
    patch: IdeaPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaRecord>;
  /** Delete an idea (its votes cascade). */
  deleteIdea(id: string, scope?: WorkspaceScope): Promise<void>;
  /** Add the acting user's vote for an idea (idempotent). Returns the record. */
  voteIdea(id: string, scope?: WorkspaceScope): Promise<IdeaRecord>;
  /** Remove the acting user's vote for an idea (idempotent). Returns the record. */
  unvoteIdea(id: string, scope?: WorkspaceScope): Promise<IdeaRecord>;
  /**
   * Promote an idea into a DB-native feature (at the planning altitude), link
   * the two, and advance the idea's status. Returns both records.
   */
  promoteIdea(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<{ idea: IdeaRecord; feature: FeatureRecord }>;
  /**
   * The workspace's admin-defined idea review stages, ordered by position, or
   * `[]` when it uses the built-in default idea workflow.
   */
  listIdeaStatuses(scope?: WorkspaceScope): Promise<IdeaStage[]>;
  /**
   * Replace the workspace's idea review stages. Ideas whose status is no longer
   * a stage are moved to the first stage. Returns the resolved stages.
   */
  replaceIdeaStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
  ): Promise<IdeaStage[]>;
  /** The workspace's Ideas configuration (portal settings). */
  getIdeaSettings(scope?: WorkspaceScope): Promise<IdeaSettings>;
  /** Update the workspace's Ideas configuration. Returns the updated settings. */
  updateIdeaSettings(
    patch: IdeaSettingsPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaSettings>;
}

/** Raised when a relation can't be created (self-link, cycle, unknown target). */
export class RelationError extends Error {}
