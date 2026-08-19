import type {
  CycleScheduleInput,
  CycleState,
  PlannedCycle,
  GoalStatus,
  MetricKind,
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
  IdeaStage,
  ProductAccess,
  ProductRole,
  ProductVisibility,
  PropertyDef,
  PropertyEntity,
  PropertyType,
  SpecSection,
  TransitionMode,
  WorkspaceLevel,
} from "@specboards/core";

import { DomainError } from "@/lib/errors";

export type {
  CycleScheduleInput,
  CycleState,
  PlannedCycle,
  GoalStatus,
  MetricKind,
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
  IdeaStage,
  ProductAccess,
  ProductRole,
  ProductVisibility,
  PropertyDef,
  PropertyEntity,
  PropertyType,
  TransitionMode,
  WorkspaceLevel,
};

/** Raised when a detail template can't be created/updated/deleted. */
export class DetailTemplateError extends DomainError {}

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
  /** Owning cycle (sprint/iteration), or null when not in one. Orthogonal to
   * releaseId: an item can hold both. */
  cycleId: string | null;
  /** Assigned user id, or null when unassigned. */
  assigneeId: string | null;
  /** Values keyed by custom-property key (see PropertyDef). */
  customFields: Record<string, CustomFieldValue>;
  /** RICE reach input, or null when unset. */
  riceReach: number | null;
  /** RICE impact multiplier (3/2/1/0.5/0.25), or null when unset. */
  riceImpact: number | null;
  /** RICE confidence as a whole percentage (0-100), or null when unset. */
  riceConfidence: number | null;
  /** RICE effort in person-months (> 0), or null when unset. */
  riceEffort: number | null;
  /** Derived RICE score; null until all four inputs are set. Read-only. */
  riceScore: number | null;
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
  /**
   * Head branch of a pull request Specboards opened to propose a change to this
   * item's spec, or null for every other link. Non-null is the marker for "this
   * is a pending change to the spec", which a hand-linked pull request is not.
   */
  headBranch: string | null;
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
  /**
   * Which connected repository the artifact lives in, as `owner/name`. Only
   * needed when the item's repo can't be inferred (a DB-native card in a
   * workspace with several connected repos); otherwise omit it.
   */
  repo?: string | null;
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
  /** Set only by the spec write path; see {@link GithubLink.headBranch}. */
  headBranch?: string | null;
  /**
   * Who proposed the change, so they can be told what became of it. Set only by
   * the spec write path. Where several people edit into one open proposal this
   * stays the person who opened it rather than whoever wrote last.
   */
  authorId?: string | null;
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
  /**
   * Blob sha the cached `content` came from, or null for a DB-native card.
   * Handed to the editor so a save can be guarded against a change made in git
   * since the page rendered: the sha has to be the one the *author* was looking
   * at, so re-reading it at write time would guard nothing.
   */
  blobSha: string | null;
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
    | "cycleId"
    | "assigneeId"
    | "customFields"
    | "parentSpecId"
    | "riceReach"
    | "riceImpact"
    | "riceConfidence"
    | "riceEffort"
  >
> & {
  /** Markdown body for a DB-native item; ignored for spec-backed items. */
  details?: string | null;
};

/**
 * Fields to create a work item with no spec attached, at any level including
 * the leaf (a spec is an attachment, not an identity - see ADR 0003).
 * `parentSpecId`, when set, must be the level immediately above.
 */
export interface CreateFeatureInput {
  title: string;
  level: string;
  /** Owning product; defaults to the workspace's default product when omitted. */
  productId?: string | null;
  parentSpecId?: string | null;
  status?: string;
  assigneeId?: string | null;
  /** Release to schedule the new item into; must belong to the item's product
   * or be a portfolio release. Null/omitted leaves it unscheduled. */
  releaseId?: string | null;
  /** Cycle to schedule the new item into; must belong to the item's product or
   * be workspace-wide. Null/omitted leaves it out of any cycle. */
  cycleId?: string | null;
  /** Initial values for the workspace's custom properties, keyed by property key. */
  customFields?: Record<string, CustomFieldValue>;
  tags?: string[];
  /** Markdown body for the new DB-native item, or null/omitted for a blank body. */
  details?: string | null;
}

/** Options for deleting a work item (see Store.deleteFeature). */
export interface DeleteFeatureOptions {
  /** True when the caller has already deleted the item's spec file from git,
   * which is what makes deleting a spec-backed item safe from re-import. */
  specRemoved?: boolean;
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
export class GroupError extends DomainError {}

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

/**
 * One `blocks` relation, as spec ids. Stored one way only (blocker to blocked),
 * so "blocked by" is the `blockedSpecId` side.
 */
export interface BlockingEdge {
  blockerSpecId: string;
  blockedSpecId: string;
}

/** One item flagged by a portfolio signal, with just enough to link to it. */
export interface SignalItem {
  specId: string;
  title: string;
  level: string;
  status: string;
  productId: string | null;
  releaseId: string | null;
  /** Whole days since the item last changed. Only meaningful for `stale`. */
  staleDays?: number;
}

/**
 * Work worth escalating, workspace-wide. Each list is capped (see
 * SIGNAL_SAMPLE_LIMIT) while `counts` stays the true total, so a dashboard can
 * show a handful of examples without implying they are all of them.
 */
export interface WorkspaceSignals {
  /** Not done, and something blocks it (an inbound `blocks` relation). */
  blocked: SignalItem[];
  /** Not done, and the target date of its release has passed. */
  overdue: SignalItem[];
  /** Mid-workflow but untouched for `staleDays` days. */
  stale: SignalItem[];
  counts: { blocked: number; overdue: number; stale: number };
}

/** Options shaping the workspace roll-up's signals. */
export interface WorkspaceSummaryOptions {
  /** Today as `YYYY-MM-DD`, supplied by the caller so the result is deterministic. */
  today: string;
  /**
   * Statuses that count as work in flight: everything between the first stage
   * and done. The workflow lives above the store (stages are workspace
   * configurable and renameable), so the caller resolves this rather than the
   * store guessing at status keys.
   */
  activeStatuses: string[];
  /** Days without an update before in-flight work is called stale. Default 14. */
  staleDays?: number;
}

/**
 * The whole workspace rolled up: one summary per readable product (the same
 * shape and the same aggregation a group roll-up uses, over every readable
 * product instead of one subtree) plus the escalation signals.
 *
 * Products in no group are included, which is the gap a per-group roll-up
 * cannot cover.
 */
export interface WorkspaceSummary {
  products: GroupProductSummary[];
  signals: WorkspaceSignals;
}

/** How many example items each signal carries. */
export const SIGNAL_SAMPLE_LIMIT = 8;

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

/**
 * A role as it can appear on a listed member. Adds `service` (a machine
 * account) to the settable {@link OrgRole}s: service members are created via
 * the service-account flow, never invited or assigned, so they can be shown
 * but not chosen in the invite / role-change UI.
 */
export type MemberDisplayRole = OrgRole | "service";

/** An org member joined to their identity, as returned to the client. */
export interface OrgMemberRecord {
  userId: string;
  name: string;
  email: string;
  role: MemberDisplayRole;
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
export class ProductError extends DomainError {}

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
  /** Which record the property is for; defaults to 'item' when omitted. */
  entity?: PropertyEntity;
  options?: string[];
  /** Level keys the property applies to; null/omitted = every level. Ignored
   * for release-scoped properties. */
  levels?: string[] | null;
}

export type PropertyPatch = Partial<{
  label: string;
  options: string[];
  levels: string[] | null;
  position: number;
}>;

/** Raised when a property can't be created/updated/deleted. */
export class PropertyError extends DomainError {}

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
export class StageGateError extends DomainError {}

export type ReleaseStatus = "planned" | "in_progress" | "shipped";

export const RELEASE_STATUSES: readonly ReleaseStatus[] = [
  "planned",
  "in_progress",
  "shipped",
];

/**
 * The customer-facing release-notes mode on a release, distinct from the
 * internal planning `notes`. `none`: no release notes. `in_app`: Markdown
 * authored in the app (`releaseNotesBody`). `external`: a link to externally
 * hosted notes (`releaseNotesUrl`).
 */
export type ReleaseNotesMode = "none" | "in_app" | "external";

export const RELEASE_NOTES_MODES: readonly ReleaseNotesMode[] = [
  "none",
  "in_app",
  "external",
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
  /** The date the release actually shipped (YYYY-MM-DD), stamped when it first
   * transitions to `shipped` and cleared on reopen. Null while unshipped. */
  shippedDate: string | null;
  /** Internal planning notes (Markdown), or null. Distinct from the
   * customer-facing release notes below. */
  notes: string | null;
  /** Customer-facing release-notes mode: none / in_app / external. */
  releaseNotesMode: ReleaseNotesMode;
  /** In-app authored release notes (Markdown), or null. Rendered when the mode
   * is `in_app`; retained across mode switches so a draft survives. */
  releaseNotesBody: string | null;
  /** External release-notes URL, or null. Linked out to when the mode is
   * `external`; retained across mode switches. */
  releaseNotesUrl: string | null;
  /** Values for release-scoped custom properties, keyed by property key
   * (mirrors an item's customFields). */
  customFields: Record<string, CustomFieldValue>;
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
  releaseNotesMode?: ReleaseNotesMode;
  releaseNotesBody?: string | null;
  releaseNotesUrl?: string | null;
  customFields?: Record<string, CustomFieldValue>;
}

export type ReleasePatch = Partial<{
  name: string;
  productId: string | null;
  status: ReleaseStatus;
  startDate: string | null;
  targetDate: string | null;
  notes: string | null;
  releaseNotesMode: ReleaseNotesMode;
  releaseNotesBody: string | null;
  releaseNotesUrl: string | null;
  customFields: Record<string, CustomFieldValue>;
}>;

/** Raised when a release can't be created/updated/deleted. */
export class ReleaseError extends DomainError {}

/**
 * A cycle (sprint / iteration) as the UI consumes it: a date-bounded time box,
 * orthogonal to releases. Note there is no stored status - `state` is derived
 * from the dates on every read (see core `cycleState`), so a cycle can never be
 * stale and nothing has to run to keep it current.
 */
export interface CycleRecord {
  id: string;
  name: string;
  /** Product this cycle belongs to, or null for a workspace-wide cycle
   * spanning every product. */
  productId: string | null;
  /** Inclusive first day, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive last day, YYYY-MM-DD. */
  endDate: string;
  /** Free-form notes (Markdown), e.g. the cycle's goal. */
  notes: string | null;
  /** Derived from the dates against today; never stored. */
  state: CycleState;
  /** Count of items scheduled into this cycle. */
  itemCount: number;
  /** Of those items, how many are in a terminal ("done") status. Drives the
   * cycle's progress and the rollover count. */
  doneCount: number;
}

export interface CycleInput {
  name: string;
  /** Product to scope the cycle to, or null/omitted for a workspace-wide one. */
  productId?: string | null;
  startDate: string;
  endDate: string;
  notes?: string | null;
}

export type CyclePatch = Partial<{
  name: string;
  productId: string | null;
  startDate: string;
  endDate: string;
  notes: string | null;
}>;

/**
 * Generate a whole run of cycles at once: a cadence, a horizon, and a naming
 * pattern. The date and name arithmetic is the core `CycleScheduleInput`; this
 * adds only the scoping a store needs.
 */
export interface CycleGenerateInput extends CycleScheduleInput {
  /** Product to scope every generated cycle to, or null for workspace-wide. */
  productId?: string | null;
  /** Notes applied to every generated cycle. Usually left empty. */
  notes?: string | null;
}

/** Outcome of rolling a cycle's unfinished work into another cycle. */
export interface CycleRolloverResult {
  /** Number of items moved. */
  moved: number;
  /** The cycle they were moved into. */
  toCycleId: string;
}

/** Raised when a cycle can't be created/updated/deleted. */
export class CycleError extends DomainError {}

/** One key result under a goal, with its progress computed on read. */
export interface KeyResultRecord {
  id: string;
  goalId: string;
  title: string;
  metricKind: MetricKind;
  startValue: number;
  targetValue: number;
  currentValue: number;
  position: number;
  /** Computed from start/current/target; null when the measure is degenerate.
   * Never stored (see core `keyResultProgress`). */
  progress: number | null;
}

/**
 * A goal (objective) as the UI consumes it. Note the two progress numbers,
 * which stay separate on purpose: `progress` measures the outcome (key
 * results), `deliveryProgress` measures how much of the linked work has
 * shipped. Shipping everything and moving no metric is precisely what OKRs
 * exist to surface, so they are never merged.
 */
export interface GoalRecord {
  id: string;
  title: string;
  description: string | null;
  /** Product this goal belongs to, or null for an org-wide goal. */
  productId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Parent goal, or null at the root of the goal tree. */
  parentGoalId: string | null;
  /** The owner's confidence call; distinct from computed progress. */
  status: GoalStatus;
  keyResults: KeyResultRecord[];
  /** Mean of the key results' progress; null when there are none. */
  progress: number | null;
  /** Count of work items linked to this goal that the caller can read. */
  linkedItemCount: number;
  /** Share of those linked items in a terminal status; null when none. */
  deliveryProgress: number | null;
}

export interface GoalInput {
  title: string;
  description?: string | null;
  productId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  parentGoalId?: string | null;
  status?: GoalStatus;
}

export type GoalPatch = Partial<{
  title: string;
  description: string | null;
  productId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  parentGoalId: string | null;
  status: GoalStatus;
}>;

export interface KeyResultInput {
  title: string;
  metricKind?: MetricKind;
  startValue?: number;
  targetValue: number;
  currentValue?: number;
}

export type KeyResultPatch = Partial<{
  title: string;
  metricKind: MetricKind;
  startValue: number;
  targetValue: number;
  currentValue: number;
  position: number;
}>;

/** A work item contributing to a goal, as the goal detail lists it. */
export interface GoalContribution {
  specId: string;
  title: string;
  status: string;
  level: string;
  productId: string | null;
  /** True when the item's status is terminal (feeds deliveryProgress). */
  done: boolean;
}

/** One goal-to-item edge, as a view that needs the whole graph reads it. */
export interface GoalLinkRef {
  goalId: string;
  specId: string;
}

/** A goal an item ladders up to, as the item detail lists it. */
export interface ItemGoalRef {
  goalId: string;
  title: string;
  status: GoalStatus;
  productId: string | null;
}

/** Raised when a goal or key result can't be created/updated/deleted. */
export class GoalError extends DomainError {}

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
export class CommentError extends DomainError {}

/** A notification as the inbox renders it, actor + target resolved. */
export interface NotificationRecord {
  id: string;
  /**
   * Kind of notification: "mention", or the outcome of a spec change the
   * recipient proposed ("spec_change_merged" / "spec_change_closed").
   */
  type: string;
  actorId: string | null;
  actorName: string | null;
  /** Stable spec id of the item the source comment lives on (for deep-linking). */
  specId: string;
  /** The item's level key and product slug, to build its permalink. */
  featureLevel: string;
  productSlug: string;
  featureTitle: string;
  /** The source comment, or null for a notification with no comment behind it. */
  commentId: string | null;
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

// Cycle helpers live in core (they are pure date logic shared with the CLI);
// re-exported here so UI code imports its scoping helpers from one place,
// alongside releasesForProduct / selectableReleases below.
export {
  buildGoalTree,
  compareGoals,
  deliveryProgress,
  flattenGoalTree,
  formatMetric,
  goalProgress,
  goalStatusLabel,
  goalsForProduct,
  isGoalClosed,
  isGoalStatus,
  keyResultProgress,
  GOAL_STATUSES,
  METRIC_KINDS,
} from "@specboards/core";
export type { GoalTreeNode, GoalTreeRow } from "@specboards/core";

export {
  addDaysDateOnly,
  compareCycles,
  cycleDaysRemaining,
  cycleLengthDays,
  cycleScheduleRemainderDays,
  cycleState,
  cycleStateLabel,
  cyclesForProduct,
  generateCycleSchedule,
  isCycleActive,
  nextCycleNumber,
  selectableCycles,
  todayDateOnly,
  validateCycleScheduleInput,
  CYCLE_NUMBER_TOKEN,
  MAX_GENERATED_CYCLES,
} from "@specboards/core";

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

/**
 * Releases offered in a scheduling picker: the unshipped ones, plus `keepId`
 * (the item's currently-assigned release) even if it has since shipped, so an
 * existing value never disappears from its own dropdown. Shared by the filter
 * bar, the create drawer, and the item edit view so they agree on what a
 * schedulable release is. Pass `keepId = null` where there is no current value
 * (creating, or the filter bar with no active release filter).
 */
export function selectableReleases(
  releases: ReleaseRecord[],
  keepId: string | null = null,
): ReleaseRecord[] {
  return releases.filter((r) => r.status !== "shipped" || r.id === keepId);
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

/**
 * Order shipped releases newest-first (most recently shipped on the left), the
 * inverse of the planned ordering: the latest release users shipped is what they
 * most want to reach, so it shouldn't sit at the far end of a long history. Sorts
 * by the actual ship date (falling back to the planned target date for older
 * releases with no stamp), most recent first; undated last, then by name.
 */
export function compareShippedReleases(
  a: Pick<ReleaseRecord, "shippedDate" | "targetDate" | "name">,
  b: Pick<ReleaseRecord, "shippedDate" | "targetDate" | "name">,
): number {
  const da = a.shippedDate ?? a.targetDate;
  const db = b.shippedDate ?? b.targetDate;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da > db ? -1 : 1;
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

/**
 * How every product in the workspace is configured for transitions: the default
 * plus the products that depart from it.
 *
 * `overrides` holds only products that have actually set a mode. A product that
 * is absent inherits `workspaceDefault`, and so does a product whose row exists
 * with no mode on it, so callers never have to distinguish "no row" from
 * "explicitly inheriting" — both mean the same thing to a reader.
 */
export interface TransitionModeSettings {
  workspaceDefault: TransitionMode;
  overrides: Record<string, TransitionMode>;
}

/**
 * Which Cards settings one product has taken over, rather than inheriting.
 *
 * The settings screen needs this to say "following the workspace default"
 * versus "this product's own" without re-deriving it per panel, and it cannot
 * be inferred from the resolved values: a product that overrides a setting to
 * exactly what it was inheriting is still overriding, and will not follow the
 * workspace when the default next changes.
 *
 * Every field is false for the workspace default scope, which inherits nothing.
 */
export interface CardsOverrides {
  transitionMode: boolean;
  stages: boolean;
  stageGates: boolean;
  properties: boolean;
  detailTemplates: boolean;
  /** Built-in field visibility, for at least one level. */
  cardFields: boolean;
  /** Default detail template, for at least one level. */
  levelTemplates: boolean;
}

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
export class IdeaError extends DomainError {}

/** The Plan-section areas that hold team docs. */
export const DOC_AREAS = ["strategy", "research", "architecture"] as const;
export type DocArea = (typeof DOC_AREAS)[number];

export function isDocArea(v: unknown): v is DocArea {
  return typeof v === "string" && (DOC_AREAS as readonly string[]).includes(v);
}

/**
 * Where an area's docs live: `local` (pages held in Specboards), `external`
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
export class DocError extends DomainError {}

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
export class FeatureError extends DomainError {}

/** Raised when a hierarchy-level config update is invalid or unsafe. */
export class LevelError extends DomainError {}

/**
 * Per-request tenant context. Carries the acting user and their workspace so
 * the DB store can both filter rows by `workspaceId` and set the `app.user_id`
 * session variable that RLS keys on. `undefined` only in local file mode,
 * where there is a single implicit workspace.
 */
export interface WorkspaceScope {
  userId: string;
  workspaceId: string;
  /**
   * How this change is reaching us. Omitted means a person in the browser,
   * which is the safe default only because it is also the common one: every
   * caller that is *not* a person is expected to say so.
   *
   * This is separate from `userId` because both matter. An MCP agent
   * authenticates with an API key that belongs to a person, so the change is
   * attributable to them and was still not typed by them. Reporting that cannot
   * tell those apart cannot answer "what did the team change this month".
   */
  actor?: ActorRef;
}

/** Kinds of thing that can change an item. */
export type ActorType = "user" | "api_key" | "agent" | "sync" | "system";

/** Window and filters for an activity report. */
export interface ActivityQuery {
  /** Inclusive ISO start of the reporting window. */
  from: string;
  /** Exclusive ISO end. */
  to: string;
  /**
   * Limit to these products. Omitted or null reports across everything
   * readable; an empty list reports nothing, which is what an empty product
   * group must get. A list rather than a single id because a group's report
   * covers its whole subtree, and reporting the workspace total under a group's
   * name would overstate that group's output.
   */
  productIds?: string[] | null;
}

/**
 * Cross-item reporting over the change ledger.
 *
 * `since` is the oldest event the workspace holds, and every report has to show
 * it. The ledger starts when it was deployed, so a window reaching back further
 * looks like a period of no activity when it is really a period of no
 * recording, and a reader who is not told that will see a fall in output that
 * never happened.
 */
export interface ActivitySummary {
  since: string | null;
  total: number;
  byActor: {
    actorType: ActorType;
    actorId: string | null;
    actorLabel: string | null;
    count: number;
  }[];
  /** Grouped by what was changed, so "what kind of work is this" is answerable. */
  byField: { type: string; field: string | null; count: number }[];
  byDay: { day: string; count: number }[];
  /**
   * Average time an item sat in a stage before moving on, in hours.
   *
   * Only spans between two recorded status changes count. An item's *current*
   * stage is still running and has no end, and the stage it was in before the
   * ledger existed has no recorded start, so both are excluded rather than
   * guessed. `samples` is how many completed spans the average is drawn from,
   * which is the number that says whether to trust it.
   */
  stageTime: { status: string; averageHours: number; samples: number }[];
}

/**
 * One recorded change to an item, as the change log reads it back.
 *
 * `before`/`after` are the stored values, not rendered text: turning a status
 * key or an assignee id into something a person can read needs the workspace's
 * workflow and member list, which belong to the reader rather than the record.
 * Keeping the raw values is also what makes revert possible.
 */
export interface ItemEvent {
  id: string;
  type: string;
  field: string | null;
  before: unknown;
  after: unknown;
  actorType: ActorType;
  actorId: string | null;
  /** Display name captured when the change was made. */
  actorLabel: string | null;
  /** ISO 8601; serializable across the server/client boundary. */
  createdAt: string;
}

/**
 * Who made a change, as the ledger records it.
 *
 * `label` is snapshotted at write time rather than joined on read: users get
 * renamed and deleted, and a history that turns into a column of nulls when
 * somebody leaves the company is not a history.
 */
export interface ActorRef {
  type: ActorType;
  /** The user the action ran as, including an API key's owner. */
  id: string | null;
  label: string | null;
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

/** Editable fields on an existing saved view (its `view` list is immutable). */
export interface SavedViewPatch {
  name?: string;
  filters?: SavedViewFilters;
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
  /**
   * The Markdown bodies of many items at once, keyed by spec id.
   *
   * `listFeatures` deliberately does not carry bodies: it backs the board, which
   * draws hundreds of cards and needs none of them. This exists for the one
   * caller that needs the opposite - the release assistant, which is writing
   * *about* the work and has nothing to say from titles alone - and it is a bulk
   * read rather than a loop over `getFeature` because a forty-item release would
   * otherwise be forty round trips.
   *
   * Scoped like every other read: an item the caller cannot see is absent from
   * the map rather than present and empty, so a caller cannot tell "no body"
   * from "not yours". Ids that do not exist are simply absent too.
   */
  listFeatureBodies(
    specIds: readonly string[],
    scope?: WorkspaceScope,
  ): Promise<Map<string, string>>;
  getFeature(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<FeatureDetail | null>;
  /**
   * The workspace's hierarchy levels, ordered top → leaf, with one product's
   * Cards overrides applied. The hierarchy itself is always workspace-wide;
   * `productId` only changes what each level *shows* (its built-in fields and
   * default template). Omit it for the workspace default.
   */
  listLevels(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]>;
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
    productId?: string | null,
  ): Promise<WorkspaceLevel[]>;
  /**
   * The workspace's admin-defined workflow stages, ordered by position, or `[]`
   * when the workspace uses the built-in default workflow.
   */
  listStatuses(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceStatus[]>;
  /**
   * The custom properties a view spanning several products should show: the
   * workspace default's, plus any a product in `productIds` defines that the
   * default does not. Deduplicated by (entity, key), default first. Same
   * reasoning as `listStatusesUnion`: a combined view should not drop a column
   * because only one of its products defines it.
   */
  listPropertiesUnion(
    scope: WorkspaceScope | undefined,
    productIds: string[] | null,
    entity?: PropertyEntity,
  ): Promise<PropertyDef[]>;
  /**
   * The stages a board spanning several products should show: the workspace
   * default's, plus any stage a product in `productIds` defines that the
   * default does not, appended after it. Nothing is ever hidden, so an item
   * cannot vanish from a cross-product board because its product uses a stage
   * the default has never heard of. `null` or an empty list is the default's
   * set on its own.
   */
  listStatusesUnion(
    scope: WorkspaceScope | undefined,
    productIds: string[] | null,
  ): Promise<WorkspaceStatus[]>;
  /**
   * Replace the workspace's workflow stages. Items whose status is no longer a
   * stage (and isn't the system `archived` status) are moved to the first
   * stage. Returns the resolved, ordered stages after the update.
   */
  replaceStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceStatus[]>;
  /**
   * The workspace's stage gates (checklist items per stage), ordered by stage
   * then position. `[]` when no gates are defined.
   */
  listStageGates(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<StageGate[]>;
  /**
   * Replace the workspace's stage gates wholesale. Positions follow the given
   * order within each stage. Completions for removed gates are dropped (FK
   * cascade). Returns the resolved, ordered gates after the update.
   */
  replaceStageGates(
    gates: StageGateInput[],
    scope?: WorkspaceScope,
    productId?: string | null,
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
  /** The workspace's custom properties, ordered by position. Pass `entity` to
   * return only item- or release-scoped properties; omit for all. */
  listProperties(
    scope?: WorkspaceScope,
    entity?: PropertyEntity,
    productId?: string | null,
  ): Promise<PropertyDef[]>;
  /** Create a custom property definition; returns it with its key/id. */
  createProperty(
    input: PropertyInput,
    scope?: WorkspaceScope,
    productId?: string | null,
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
  listDetailTemplates(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<DetailTemplate[]>;
  /** Create a detail template; returns the new record. */
  createDetailTemplate(
    input: DetailTemplateInput,
    scope?: WorkspaceScope,
    productId?: string | null,
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
    productId?: string | null,
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

  /** The workspace's cycles, ordered active → upcoming → most recently
   * complete. `state` on each is derived from its dates, never stored. */
  listCycles(scope?: WorkspaceScope): Promise<CycleRecord[]>;
  createCycle(input: CycleInput, scope?: WorkspaceScope): Promise<CycleRecord>;
  updateCycle(
    id: string,
    patch: CyclePatch,
    scope?: WorkspaceScope,
  ): Promise<CycleRecord>;
  /**
   * Create a whole run of cycles in one go from a cadence and a horizon, e.g.
   * fortnightly sprints to the end of the year. All or nothing: a name that
   * collides with an existing cycle aborts the run rather than leaving a
   * half-built schedule someone has to finish or unpick by hand.
   */
  generateCycles(
    input: CycleGenerateInput,
    scope?: WorkspaceScope,
  ): Promise<CycleRecord[]>;
  /** Delete a cycle. `features.cycle_id` is ON DELETE SET NULL, so its items
   * are unscheduled rather than deleted. */
  deleteCycle(id: string, scope?: WorkspaceScope): Promise<void>;
  /**
   * Move every unfinished item out of `fromId` and into `toId`. An explicit
   * user action, never a background job: what carries over is a planning
   * decision the team makes when they close a cycle, and a cron that guessed
   * would be wrong as often as right. Items already done stay where they are,
   * so the finished cycle keeps an honest record of what it delivered.
   */
  rolloverCycle(
    fromId: string,
    toId: string,
    scope?: WorkspaceScope,
  ): Promise<CycleRolloverResult>;

  /** The workspace's goals with their key results and computed progress,
   * ordered open first, then by soonest period end. */
  listGoals(scope?: WorkspaceScope): Promise<GoalRecord[]>;
  createGoal(input: GoalInput, scope?: WorkspaceScope): Promise<GoalRecord>;
  updateGoal(
    id: string,
    patch: GoalPatch,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord>;
  /** Delete a goal. Its key results cascade; its links to work items are
   * removed, and the work items themselves are untouched. */
  deleteGoal(id: string, scope?: WorkspaceScope): Promise<void>;

  createKeyResult(
    goalId: string,
    input: KeyResultInput,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord>;
  updateKeyResult(
    id: string,
    patch: KeyResultPatch,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord>;
  deleteKeyResult(id: string, scope?: WorkspaceScope): Promise<GoalRecord>;

  /** Work items linked to a goal, filtered to those the caller can read. The
   * goal itself stays visible even when some of its work does not. */
  listGoalContributions(
    goalId: string,
    scope?: WorkspaceScope,
  ): Promise<GoalContribution[]>;
  /**
   * Every goal-to-item link in the workspace, filtered to readable work. One
   * call for a view that needs them all (the roadmap's goal swimlanes), where
   * a `listGoalContributions` per goal would be a query per lane.
   */
  listGoalLinks(scope?: WorkspaceScope): Promise<GoalLinkRef[]>;
  /** Goals an item ladders up to (many-to-many; any level can link). */
  listItemGoals(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<ItemGoalRef[]>;
  linkGoal(
    goalId: string,
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<void>;
  unlinkGoal(
    goalId: string,
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<void>;
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
  /**
   * Every `blocks` relation in the workspace whose *both* ends the caller can
   * read, as spec ids. One query for a view that needs the whole dependency
   * graph (the portfolio timeline's edges) rather than one item's relations.
   */
  listBlockingEdges(scope?: WorkspaceScope): Promise<BlockingEdge[]>;
  /** A group's roll-up over the readable products in its subtree. */
  getGroupSummary(id: string, scope?: WorkspaceScope): Promise<GroupSummary>;
  /**
   * The workspace's roll-up: every readable product (grouped or not) plus the
   * escalation signals. Shares its aggregation with getGroupSummary, so the two
   * dashboards can never disagree about what a status count means.
   */
  getWorkspaceSummary(
    options: WorkspaceSummaryOptions,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceSummary>;
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
  /** Delete a work item by id. An item with a spec attached is refused unless
   * the caller has already removed its git file and passes `specRemoved`, since
   * a surviving file would be re-imported by the next sync (ADR 0003 D4).
   * `emit`, when given, records an outbox event in the same transaction. */
  deleteFeature(
    specId: string,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
    opts?: DeleteFeatureOptions,
  ): Promise<void>;
  /**
   * Delete `specId` if, and only if, it is an auto-created Feature grouping
   * (see github-sync) that has lost its last child and that nobody has touched:
   * generated title, default status, and no release, assignee, tags, custom
   * fields, RICE inputs, rank, details, relations, GitHub links, or comments.
   *
   * Exists because sync homes each imported spec under a grouping keyed by its
   * folder, and `create_spec` gives every spec its own folder, so re-parenting
   * the spec under a real card left a same-named grouping behind with nothing
   * in it. Returns true when a grouping was removed. Never throws for an
   * ineligible or missing row: it is opportunistic cleanup behind another
   * write, and must not fail the write that triggered it.
   */
  pruneAutoGrouping(specId: string, scope?: WorkspaceScope): Promise<boolean>;
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
  /**
   * One item's change history, newest first. Covers the fields Specboards
   * stores; a spec-backed item's document history lives in git and is read
   * from there, not from here.
   */
  listItemEvents(
    specId: string,
    scope?: WorkspaceScope,
    limit?: number,
  ): Promise<ItemEvent[]>;
  /** Cross-item activity report over the change ledger. */
  itemActivitySummary(
    query: ActivityQuery,
    scope?: WorkspaceScope,
  ): Promise<ActivitySummary>;
  /** The acting user's saved backlog views (personal, newest first). */
  listSavedViews(scope?: WorkspaceScope): Promise<SavedView[]>;
  /** Persist a new saved view for the acting user; returns it with its id. */
  createSavedView(
    input: SavedViewInput,
    scope?: WorkspaceScope,
  ): Promise<SavedView>;
  /**
   * Update one of the acting user's saved views (name and/or filters).
   * Returns the updated view, or null when no view with that id is owned by
   * the acting user.
   */
  updateSavedView(
    id: string,
    patch: SavedViewPatch,
    scope?: WorkspaceScope,
  ): Promise<SavedView | null>;
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
  /**
   * How freely items move between stages, for one product. Drives whether the
   * resolved workflow's transitions are a pipeline or fully open.
   *
   * `productId` names the product to resolve for; omit it (or pass null) for
   * the workspace-wide default. A product with no override of its own resolves
   * to that default, so a workspace that has never configured a product behaves
   * exactly as it did when this was a single workspace setting.
   */
  getTransitionMode(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<TransitionMode>;
  /**
   * Every transition mode configured in the workspace, in one read: the default
   * and each product that overrides it. For the settings screen, which has to
   * show what is inherited as well as what is set, and would otherwise need one
   * query per product to tell those apart.
   */
  listTransitionModes(scope?: WorkspaceScope): Promise<TransitionModeSettings>;
  /**
   * Which Cards settings this product has overridden. All false for the
   * workspace default (`productId` omitted), which has nothing to inherit.
   */
  cardsOverrides(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<CardsOverrides>;
  /**
   * Set the transition mode for one product, or for the workspace default when
   * `productId` is omitted. `mode: null` reverts a product to inheriting the
   * default and is rejected for the default itself, which has nothing below it.
   *
   * Writing a product needs product-admin rights on that product (or workspace
   * ownership); the default needs workspace ownership. Both are enforced in the
   * database, not only at the route. Returns the mode now in force, which for a
   * revert is the inherited one rather than the argument.
   */
  setTransitionMode(
    mode: TransitionMode | null,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<TransitionMode>;
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
export class RelationError extends DomainError {}
