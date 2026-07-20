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
  "blocks" | "blocked_by" | "relates_to" | "duplicates" | "duplicated_by";

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
  /** Product group the product belongs to, or null when ungrouped. */
  groupId: string | null;
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
  groupId: string | null;
}>;

/** A product group (management roll-up node) as the UI consumes it. */
export interface ProductGroupRecord {
  id: string;
  /** Stable slug used as the `~{key}` scope segment in product-slot URLs. */
  key: string;
  name: string;
  description: string | null;
  /** Accent-color token, or null. */
  color: string | null;
  /** Parent group id for nesting; null = top-level. */
  parentId: string | null;
  position: number;
  /** Count of products directly in this group (not descendants). */
  productCount: number;
}

export interface CreateProductGroupInput {
  name: string;
  description?: string | null;
  color?: string | null;
  parentId?: string | null;
}

export type ProductGroupPatch = Partial<{
  name: string;
  description: string | null;
  color: string | null;
  parentId: string | null;
  position: number;
}>;

/** Raised when a group can't be created/updated/deleted (cycle, depth, in
 * use, …). */
export class GroupError extends Error {}

/** One product's contribution to a group roll-up. */
export interface GroupProductSummary {
  productId: string;
  /** Total work items in the product (all levels). */
  itemCount: number;
  /** Item counts keyed by status key (see workspace statuses). */
  statusCounts: Record<string, number>;
  /** Per-release progress; `done` uses the terminal "done" status, matching
   * hierarchy roll-up progress elsewhere. Unscheduled items are not listed. */
  releases: { releaseId: string; total: number; done: number }[];
}

/**
 * A group's roll-up: the group, its direct subgroups, and a summary for every
 * readable product in its subtree (recursive). Aggregates are computed only
 * over products the viewer can read.
 */
export interface GroupSummary {
  group: ProductGroupRecord;
  subgroups: ProductGroupRecord[];
  products: GroupProductSummary[];
}

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

/** The organization-level roles (mirrors the `member_role` DB enum). `owner`
 * is the workspace admin; `member` is the read-only org baseline whose real
 * capability comes from per-product grants. */
export type OrgRole = "owner" | "member";

/** An org member joined to their identity, as returned to the client. */
export interface OrgMemberRecord {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  /** ISO timestamp when suspended, or null when active. */
  deactivatedAt: string | null;
}

/** A per-product grant carried by an invitation (applied on accept). */
export interface InvitationProductGrant {
  productId: string;
  role: ProductRole;
}

/** A pending/settled invitation, as returned to the client (no token). */
export interface OrgInvitationRecord {
  id: string;
  email: string;
  role: OrgRole;
  /** Product grants applied on accept (empty for an owner invite). */
  productGrants: InvitationProductGrant[];
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

/** Body for creating an invitation (org role + optional product grants). */
export interface InvitationInput {
  email: string;
  role: OrgRole;
  productGrants: InvitationProductGrant[];
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
  /** Product this release belongs to, or null for a workspace-wide
   * ("portfolio") release spanning every product. */
  productId: string | null;
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
  /** Product to scope the release to, or null/omitted for a portfolio release. */
  productId?: string | null;
  status?: ReleaseStatus;
  startDate?: string | null;
  targetDate?: string | null;
  notes?: string | null;
}

export type ReleasePatch = Partial<{
  name: string;
  productId: string | null;
  status: ReleaseStatus;
  startDate: string | null;
  targetDate: string | null;
  notes: string | null;
}>;

/** Raised when a release can't be created/updated/deleted. */
export class ReleaseError extends Error {}

/** A comment on a feature, with its author resolved for display. */
export interface CommentRecord {
  id: string;
  /** The parent feature's internal id (not its stable specId). */
  featureId: string;
  authorId: string;
  /** Author's display name, or null if the user record is gone/unknown. */
  authorName: string | null;
  /** Author's avatar URL, or null. */
  authorImage: string | null;
  body: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Fields to create a comment (id/author/createdAt are assigned by the store). */
export interface CommentInput {
  body: string;
  /**
   * User ids named via @mention in the body. Accepted by the write path now;
   * validating them and fanning out notifications lands in a later slice. The
   * store persists only the comment itself for the moment.
   */
  mentionedUserIds?: string[];
}

/** Raised when a comment can't be created/read/deleted. */
export class CommentError extends Error {}

/** A notification as the inbox renders it, actor + target resolved. */
export interface NotificationRecord {
  id: string;
  /** Kind of notification; currently only "mention". */
  type: string;
  actorId: string | null;
  actorName: string | null;
  /** Stable spec id of the item the source comment lives on (for deep-linking). */
  specId: string;
  /** The item's level key and product slug, to build its permalink. */
  featureLevel: string;
  productSlug: string;
  featureTitle: string;
  commentId: string;
  snippet: string;
  /** True once the recipient has read it. */
  read: boolean;
  createdAt: string;
}

/** The inbox payload: the recipient's notifications plus their unread total. */
export interface NotificationList {
  items: NotificationRecord[];
  unreadCount: number;
}

/** The releases a single product's roadmap should show: that product's own
 * releases plus workspace-wide (portfolio) releases, which apply everywhere. */
export function releasesForProduct(
  releases: ReleaseRecord[],
  productId: string,
): ReleaseRecord[] {
  return releases.filter(
    (r) => r.productId === null || r.productId === productId,
  );
}

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

/** The Plan-section areas that hold team docs. */
export const DOC_AREAS = ["strategy", "research", "architecture"] as const;
export type DocArea = (typeof DOC_AREAS)[number];

export function isDocArea(v: unknown): v is DocArea {
  return typeof v === "string" && (DOC_AREAS as readonly string[]).includes(v);
}

/**
 * Where an area's docs live: `local` (pages held in Specboard), `external`
 * (link out to an outside repository like SharePoint or Box), or `github`
 * (a GitHub repo of Markdown files; a later slice). `unset` = the team
 * hasn't chosen yet, so the area shows the setup chooser.
 */
export type DocSpaceMode = "unset" | "local" | "external" | "github";

/** A product area's doc-source configuration. */
export interface DocSpace {
  productId: string;
  area: DocArea;
  mode: DocSpaceMode;
  /** Link-out URL for `external` mode, else null. */
  externalUrl: string | null;
  /** Backing repo id for `github` mode, else null. */
  repoId: string | null;
}

export interface DocSpaceInput {
  mode: Exclude<DocSpaceMode, "unset">;
  externalUrl?: string | null;
  repoId?: string | null;
}

/** A folder or Markdown page in a locally-held doc space. */
export interface DocPageRecord {
  id: string;
  productId: string;
  area: DocArea;
  /** Containing folder id, or null at the area root. */
  parentId: string | null;
  kind: "folder" | "page";
  title: string;
  /** Markdown body (empty for folders). */
  content: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocPageInput {
  productId: string;
  area: DocArea;
  parentId?: string | null;
  kind?: "folder" | "page";
  title: string;
  content?: string;
}

export type DocPagePatch = Partial<{
  title: string;
  content: string;
  parentId: string | null;
}>;

/** Raised when a doc space or doc page operation is invalid. */
export class DocError extends Error {}

/** Validate an external doc-repository link (SharePoint, Box, ...). */
export function validateExternalDocUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new DocError("A link URL is required.");
  }
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DocError("Enter a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new DocError("The link must be an http(s) URL.");
  }
  return url;
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
 * The spaces that keep their own card-field selection. Board preferences are
 * stored once per (workspace, user, board), so toggling a field on the Backlog
 * leaves the Roadmap untouched, and vice-versa.
 */
export const BOARD_KEYS = ["backlog", "roadmap"] as const;
export type BoardKey = (typeof BOARD_KEYS)[number];

/**
 * Storage boundary for the web app. Two implementations:
 * - `local`: reads specs from the filesystem, metadata in a JSON file —
 *   zero-setup local testing (scope ignored; single implicit workspace).
 * - `db`: Drizzle/Postgres (`DATABASE_URL`) — the real deployment shape;
 *   requires a `scope` and isolates every query to it.
 */
export interface FeatureStore {
  listFeatures(scope?: WorkspaceScope): Promise<FeatureRecord[]>;
  getFeature(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<FeatureDetail | null>;
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
  listGateCompletions(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<string[]>;
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
  /** The workspace's releases, dated first (ascending), undated last. Each
   * record carries its `productId` (null for a workspace-wide portfolio
   * release); callers that want a single product's roadmap filter to that
   * product plus portfolio releases. */
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
  /** Comments on a feature (by stable specId), oldest first, author resolved.
   * Requires read access to the feature's product. */
  listComments(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<CommentRecord[]>;
  /** Add a comment authored by the caller to a feature (by stable specId).
   * Requires read access to the feature's product. */
  createComment(
    specId: string,
    input: CommentInput,
    scope?: WorkspaceScope,
  ): Promise<CommentRecord>;
  /** Delete a comment; the author or the workspace owner only. */
  deleteComment(commentId: string, scope?: WorkspaceScope): Promise<void>;
  /** The caller's notifications (newest first) plus their unread total. */
  listNotifications(scope?: WorkspaceScope): Promise<NotificationList>;
  /** Mark one of the caller's notifications read (no-op if already read/gone). */
  markNotificationRead(id: string, scope?: WorkspaceScope): Promise<void>;
  /** Mark all of the caller's notifications read. */
  markAllNotificationsRead(scope?: WorkspaceScope): Promise<void>;
  /** The acting user's effective product access (org-admin flag + per-product
   * grants), used for read-filtering and write authorization. */
  getProductAccess(scope?: WorkspaceScope): Promise<ProductAccess>;
  /** Products (sibling backlogs) the acting user can see, ordered by position. */
  listProducts(scope?: WorkspaceScope): Promise<ProductRecord[]>;
  /** A single product by its key (the `?product=` slug), or null. */
  getProduct(
    key: string,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord | null>;
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
  /** All product groups in the workspace, ordered by position then name.
   * Group metadata is member-visible; roll-up surfaces additionally hide
   * groups whose subtree holds no readable product (applied by callers). */
  listProductGroups(scope?: WorkspaceScope): Promise<ProductGroupRecord[]>;
  /** Create a product group (org-admin action). Returns the new record. */
  createProductGroup(
    input: CreateProductGroupInput,
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord>;
  /** Update a group (rename/recolor/reposition/reparent). Rejects cycles and
   * nesting past MAX_GROUP_DEPTH with GroupError. */
  updateProductGroup(
    id: string,
    patch: ProductGroupPatch,
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord>;
  /** Delete a group (must have no child groups or member products). */
  deleteProductGroup(id: string, scope?: WorkspaceScope): Promise<void>;
  /** A group's roll-up over the readable products in its subtree. */
  getGroupSummary(id: string, scope?: WorkspaceScope): Promise<GroupSummary>;
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
  /**
   * The acting user's board preferences for a space, or null when none saved.
   * `board` defaults to "backlog" for callers predating per-board prefs.
   */
  getBoardPreferences(
    scope?: WorkspaceScope,
    board?: BoardKey,
  ): Promise<BoardPreferences | null>;
  /** Persist the acting user's board preferences for a space (upsert). */
  setBoardPreferences(
    prefs: BoardPreferences,
    scope?: WorkspaceScope,
    board?: BoardKey,
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
  // ── Docs (Plan-section areas) ───────────────────────────────────────────
  /** The area's doc-source configuration; mode `unset` when never chosen. */
  getDocSpace(
    productId: string,
    area: DocArea,
    scope?: WorkspaceScope,
  ): Promise<DocSpace>;
  /** Choose (or change) where the area's docs live. Returns the config. */
  setDocSpace(
    productId: string,
    area: DocArea,
    input: DocSpaceInput,
    scope?: WorkspaceScope,
  ): Promise<DocSpace>;
  /** All folders/pages in the area, parents-first order within each level. */
  listDocPages(
    productId: string,
    area: DocArea,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord[]>;
  /** Create a folder or page. Returns the new record. */
  createDocPage(
    input: DocPageInput,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord>;
  /** Update a page's title/content or move it to another folder. */
  updateDocPage(
    id: string,
    patch: DocPagePatch,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord>;
  /** Delete a folder (contents cascade) or page. */
  deleteDocPage(id: string, scope?: WorkspaceScope): Promise<void>;
}

/** Raised when a relation can't be created (self-link, cycle, unknown target). */
export class RelationError extends Error {}
