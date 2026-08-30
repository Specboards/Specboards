import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compareCycles,
  compareGoals,
  cycleState,
  generateCycleSchedule,
  deliveryProgress,
  goalProgress,
  isGoalStatus,
  keyResultProgress,
  DEFAULT_PRODUCT_KEY,
  descendantGroupIds,
  groupKeyFromName,
  isPropertyType,
  isValidParentLevel,
  leafLevel,
  DEFAULT_STATUSES,
  LOCAL_PRODUCT_ACCESS,
  parseSpec,
  productKeyFromName,
  wouldCreateCycle,
  wouldExceedDepth,
  promotedIdeaStatus,
  propertyKeyFromLabel,
  resolveIdeaStages,
  resolveLevels,
  resolveLevelUpdate,
  todayDateOnly,
  validateCycleScheduleInput,
  validateCycleDates,
  validateGoalPeriod,
  validateKeyResult,
  wouldCreateGoalCycle,
  type GoalStatus,
  type IdeaStage,
  type MetricKind,
  type PropertyDef,
  type PropertyEntity,
  type WorkspaceLevel,
} from "@specboards/core";

import { riceFields } from "@/lib/feature-helpers";
import {
  compareReleases,
  DetailTemplateError,
  FeatureError,
  GroupError,
  LevelError,
  ProductError,
  PropertyError,
  RelationError,
  ReleaseError,
  RELEASE_STATUSES,
  CommentError,
  type CommentInput,
  type CommentRecord,
  type NotificationList,
  type BoardKey,
  type BoardPreferences,
  type CreateFeatureInput,
  type CreateProductGroupInput,
  CycleError,
  GoalError,
  type GoalContribution,
  type GoalInput,
  type GoalLinkRef,
  type GoalPatch,
  type GoalRecord,
  type ItemGoalRef,
  type KeyResultInput,
  type KeyResultPatch,
  type CycleGenerateInput,
  type CycleInput,
  type CyclePatch,
  type CycleRecord,
  type CycleRolloverResult,
  type CreateProductInput,
  type DeleteFeatureOptions,
  type DetailTemplate,
  type DetailTemplateInput,
  type DetailTemplatePatch,
  DocError,
  validateExternalDocUrl,
  type DocArea,
  type DocPageInput,
  type DocPagePatch,
  type DocPageRecord,
  type DocSpace,
  type DocSpaceInput,
  type LevelUpdate,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureStore,
  type GithubLinkAggregate,
  IdeaError,
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type BlockingEdge,
  type GroupProductSummary,
  type GroupSummary,
  SIGNAL_SAMPLE_LIMIT,
  type SignalItem,
  type WorkspaceSummary,
  type WorkspaceSummaryOptions,
  type ProductAccess,
  type ProductGroupPatch,
  type ProductGroupRecord,
  type ProductMemberInput,
  type ProductMemberRecord,
  type ProductPatch,
  type ProductRecord,
  type PropertyInput,
  type PropertyPatch,
  type ReleaseInput,
  type ReleasePatch,
  type ReleaseRecord,
  type StageGate,
  type StageGateInput,
  StageGateError,
  type CardsOverrides,
  type StatusStageInput,
  type TransitionModeSettings,
  type WorkspaceStatus,
  type ResolvedGithubLink,
  type RelationDirection,
  type RelationInput,
  type SavedView,
  type SavedViewInput,
  type SavedViewPatch,
  type OutboxEmit,
  type TransitionMode,
  type ActivityQuery,
  type ActivitySummary,
  type ItemEvent,
  type WorkspaceScope,
} from "./types";

/** A DB-native work item (initiative/epic) persisted in local file mode. */
interface LocalItem {
  /** Stable id, used as the public specId. */
  id: string;
  title: string;
  level: string;
  status: string;
  assigneeId: string | null;
  tags: string[];
  parentSpecId: string | null;
  /** Owning release id, or null when unscheduled. */
  releaseId?: string | null;
  /** Owning cycle id, or null when not in one. Orthogonal to releaseId. */
  cycleId?: string | null;
  /** Owning product id; defaults to the default product when absent. */
  productId?: string | null;
  /** Markdown details body, or null/absent for a blank body. */
  details?: string | null;
  /** Custom-property values keyed by property key. */
  customFields?: Record<string, CustomFieldValue>;
  /** RICE prioritization inputs (see RiceInputs). */
  riceReach?: number | null;
  riceImpact?: number | null;
  riceConfidence?: number | null;
  riceEffort?: number | null;
}

/** A release persisted in local file mode. */
interface LocalRelease {
  id: string;
  name: string;
  /** Product this release belongs to, or null for a portfolio release. */
  productId?: string | null;
  status: "planned" | "in_progress" | "shipped";
  startDate: string | null;
  targetDate: string | null;
  /** Actual ship date (YYYY-MM-DD), stamped on ship and cleared on reopen. */
  shippedDate?: string | null;
  notes?: string | null;
  /** Customer-facing release-notes mode (default none when absent). */
  releaseNotesMode?: "none" | "in_app" | "external";
  releaseNotesBody?: string | null;
  releaseNotesUrl?: string | null;
  /** Release-scoped custom-property values (default empty when absent). */
  customFields?: Record<string, CustomFieldValue>;
}

/** A cycle (sprint/iteration) persisted in local file mode. No status field:
 * the state is derived from the dates on read, exactly as in the DB store. */
interface LocalCycle {
  id: string;
  name: string;
  /** Product this cycle belongs to, or null for a workspace-wide cycle. */
  productId?: string | null;
  startDate: string;
  endDate: string;
  notes?: string | null;
}

/** A goal persisted in local file mode, with its key results and links nested
 * (file mode has no joins to do). Progress is still computed on read. */
interface LocalGoal {
  id: string;
  title: string;
  description?: string | null;
  productId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  parentGoalId?: string | null;
  status: GoalStatus;
  keyResults?: LocalKeyResult[];
  /** Stable spec ids of the work items laddering up to this goal. */
  linkedSpecIds?: string[];
}

/** A key result nested under a LocalGoal. */
interface LocalKeyResult {
  id: string;
  title: string;
  metricKind: MetricKind;
  startValue: number;
  targetValue: number;
  currentValue: number;
  position: number;
}

/** A comment persisted in local file mode. Keyed to the feature's stable
 * specId (local mode has no separate internal id) and authored by LOCAL_USER,
 * since file mode has no user records. */
interface LocalComment {
  id: string;
  specId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

/** An idea / feature request persisted in local file mode. */
interface LocalIdea {
  id: string;
  title: string;
  description: string | null;
  status: string;
  productId: string | null;
  submitterName: string | null;
  /** Feature specId this idea was promoted into, or null. */
  promotedFeatureSpecId: string | null;
  /** User ids that voted; local mode has a single user (LOCAL_USER). */
  voters: string[];
  createdAt: string;
}

/** Ideas configuration persisted in local file mode. */
interface LocalIdeaSettings {
  portalEnabled: boolean;
  portalTitle: string | null;
}

/** The single acting user in local (auth-disabled) file mode. */
const LOCAL_USER = "local";

/** A product (sibling backlog) persisted in local file mode. */
interface LocalProduct {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: "org" | "private";
  position: number;
  color?: string | null;
  groupId?: string | null;
}

/** A product group persisted in local file mode. */
interface LocalProductGroup {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  parentId: string | null;
  position: number;
}

/** The default product seeded when none is persisted (id is stable). */
const LOCAL_DEFAULT_PRODUCT: LocalProduct = {
  id: "default",
  key: DEFAULT_PRODUCT_KEY,
  name: "General",
  description: null,
  visibility: "org",
  position: 0,
  color: null,
};

/** Zero GitHub-link aggregate; file mode has no GitHub connection. */
function emptyGithubSummary(): GithubLinkAggregate {
  return { openPrs: 0, mergedPrs: 0, issues: 0, branches: 0, total: 0 };
}

type LocalLinkType = "blocks" | "relates_to" | "duplicates";

/** A relation stored canonically on the `from` spec's metadata. */
interface LocalLink {
  to: string;
  type: LocalLinkType;
}

interface LocalMetadata {
  status?: string;
  rank?: string | null;
  tags?: string[];
  /** Owning release id, or null when unscheduled. */
  releaseId?: string | null;
  /** Owning cycle id, or null when not in one. Orthogonal to releaseId. */
  cycleId?: string | null;
  assigneeId?: string | null;
  customFields?: Record<string, CustomFieldValue>;
  /** RICE prioritization inputs (see RiceInputs). */
  riceReach?: number | null;
  riceImpact?: number | null;
  riceConfidence?: number | null;
  riceEffort?: number | null;
  /** Outgoing relations from this spec (see ./types FeatureRelation). */
  links?: LocalLink[];
  /** Parent feature (epic) spec id, or null when top-level. */
  parentSpecId?: string | null;
  /** Owning product id; defaults to the default product when absent. */
  productId?: string | null;
}

/** The terminal status used for hierarchy roll-up progress. */
function isDone(status: string): boolean {
  return status === "done";
}

type MetadataFile = Record<string, LocalMetadata>;

/** A synthetic, stable id for a local relation (no DB rows to key on). */
function localLinkId(fromSpec: string, link: LocalLink): string {
  return `${fromSpec}:${link.to}:${link.type}`;
}

/** Resolve a stored edge into the direction seen from `viewerSpec`. */
function localDirection(
  fromSpec: string,
  type: LocalLinkType,
  viewerSpec: string,
): RelationDirection {
  const outgoing = fromSpec === viewerSpec;
  switch (type) {
    case "blocks":
      return outgoing ? "blocks" : "blocked_by";
    case "duplicates":
      return outgoing ? "duplicates" : "duplicated_by";
    case "relates_to":
      return "relates_to";
  }
}

/** Map a viewer-relative direction to a canonical stored edge (by specId). */
function toLocalEdge(
  selfSpec: string,
  otherSpec: string,
  direction: RelationInput["direction"],
): { from: string; link: LocalLink } {
  switch (direction) {
    case "blocks":
      return { from: selfSpec, link: { to: otherSpec, type: "blocks" } };
    case "blocked_by":
      return { from: otherSpec, link: { to: selfSpec, type: "blocks" } };
    case "relates_to":
      return { from: selfSpec, link: { to: otherSpec, type: "relates_to" } };
    case "duplicates":
      return { from: selfSpec, link: { to: otherSpec, type: "duplicates" } };
  }
}

/**
 * Zero-setup store for local testing: specs are read straight from the
 * repository's `specs/` directory and PM metadata is persisted to
 * `.specboards/local-metadata.json`. Set `DATABASE_URL` to use Postgres
 * instead (see ./db.ts).
 */
export class LocalFileStore implements FeatureStore {
  constructor(private readonly root: string) {}

  private get specsDir() {
    return path.join(this.root, "specs");
  }

  private get metadataPath() {
    return path.join(this.root, ".specboards", "local-metadata.json");
  }

  private get viewsPath() {
    return path.join(this.root, ".specboards", "local-views.json");
  }

  private get boardPrefsPath() {
    return path.join(this.root, ".specboards", "local-board-prefs.json");
  }

  private get itemsPath() {
    return path.join(this.root, ".specboards", "local-items.json");
  }

  private get levelsPath() {
    return path.join(this.root, ".specboards", "local-levels.json");
  }

  private get productsPath() {
    return path.join(this.root, ".specboards", "local-products.json");
  }

  private get propertiesPath() {
    return path.join(this.root, ".specboards", "local-properties.json");
  }

  private get releasesPath() {
    return path.join(this.root, ".specboards", "local-releases.json");
  }

  private get cyclesPath() {
    return path.join(this.root, ".specboards", "local-cycles.json");
  }

  private get commentsPath() {
    return path.join(this.root, ".specboards", "local-comments.json");
  }

  private get statusesPath() {
    return path.join(this.root, ".specboards", "local-statuses.json");
  }

  private get stageGatesPath() {
    return path.join(this.root, ".specboards", "local-stage-gates.json");
  }

  /** Per-item gate completions: specId -> completed gate ids. */
  private get gateCompletionsPath() {
    return path.join(this.root, ".specboards", "local-gate-completions.json");
  }

  private get ideasPath() {
    return path.join(this.root, ".specboards", "local-ideas.json");
  }

  private get ideaStatusesPath() {
    return path.join(this.root, ".specboards", "local-idea-statuses.json");
  }

  private get ideaSettingsPath() {
    return path.join(this.root, ".specboards", "local-idea-settings.json");
  }

  private get templatesPath() {
    return path.join(this.root, ".specboards", "local-detail-templates.json");
  }

  /** Persisted products, seeded with the default product when none exist. */
  private async readProducts(): Promise<LocalProduct[]> {
    try {
      const rows = JSON.parse(
        await fs.readFile(this.productsPath, "utf8"),
      ) as LocalProduct[];
      if (rows.length > 0) return rows;
    } catch {
      /* fall through to the seed */
    }
    return [{ ...LOCAL_DEFAULT_PRODUCT }];
  }

  private async writeProducts(rows: LocalProduct[]): Promise<void> {
    await fs.mkdir(path.dirname(this.productsPath), { recursive: true });
    await fs.writeFile(
      this.productsPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  private get productGroupsPath() {
    return path.join(this.root, ".specboards", "local-product-groups.json");
  }

  private async readGroups(): Promise<LocalProductGroup[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.productGroupsPath, "utf8"),
      ) as LocalProductGroup[];
    } catch {
      return [];
    }
  }

  private async writeGroups(rows: LocalProductGroup[]): Promise<void> {
    await fs.mkdir(path.dirname(this.productGroupsPath), { recursive: true });
    await fs.writeFile(
      this.productGroupsPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  /** The default product id (the seeded "default", or the first product). */
  private async defaultProductId(): Promise<string> {
    const products = await this.readProducts();
    return (
      products.find((p) => p.key === DEFAULT_PRODUCT_KEY)?.id ??
      products[0]?.id ??
      LOCAL_DEFAULT_PRODUCT.id
    );
  }

  /** The configured hierarchy levels, or null when none are persisted. */
  private async readLevels(): Promise<WorkspaceLevel[] | null> {
    try {
      return JSON.parse(
        await fs.readFile(this.levelsPath, "utf8"),
      ) as WorkspaceLevel[];
    } catch {
      return null;
    }
  }

  private async writeLevels(levels: WorkspaceLevel[]): Promise<void> {
    await fs.mkdir(path.dirname(this.levelsPath), { recursive: true });
    await fs.writeFile(
      this.levelsPath,
      JSON.stringify(levels, null, 2) + "\n",
      "utf8",
    );
  }

  /** DB-native work items (initiatives/epics) persisted alongside metadata. */
  private async readItems(): Promise<LocalItem[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.itemsPath, "utf8"),
      ) as LocalItem[];
    } catch {
      return [];
    }
  }

  private async writeItems(items: LocalItem[]): Promise<void> {
    await fs.mkdir(path.dirname(this.itemsPath), { recursive: true });
    await fs.writeFile(
      this.itemsPath,
      JSON.stringify(items, null, 2) + "\n",
      "utf8",
    );
  }

  private async readMetadata(): Promise<MetadataFile> {
    try {
      return JSON.parse(
        await fs.readFile(this.metadataPath, "utf8"),
      ) as MetadataFile;
    } catch {
      return {};
    }
  }

  private async writeMetadata(meta: MetadataFile): Promise<void> {
    await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
    await fs.writeFile(
      this.metadataPath,
      JSON.stringify(meta, null, 2) + "\n",
      "utf8",
    );
  }

  private async walkSpecFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await this.walkSpecFiles(full)));
      else if (entry.isFile() && entry.name === "spec.md") files.push(full);
    }
    return files;
  }

  private async loadAll(): Promise<FeatureDetail[]> {
    const [files, meta, items, levels, defaultProductId, statuses] =
      await Promise.all([
        this.walkSpecFiles(this.specsDir),
        this.readMetadata(),
        this.readItems(),
        this.readLevels(),
        this.defaultProductId(),
        this.listStatuses(),
      ]);
    const leafKey = leafLevel(levels).key;
    // Where a spec sits before anyone moves it. The first configured stage
    // rather than the literal "backlog": a workflow that renames or drops that
    // stage would otherwise resolve every untouched spec to a column the board
    // does not draw, and no amount of re-homing fixes it because there is no
    // stored status to re-home.
    const firstStage = statuses[0]?.key ?? "backlog";
    const features: FeatureDetail[] = [];
    for (const file of files) {
      const raw = await fs.readFile(file, "utf8");
      let parsed;
      try {
        parsed = parseSpec(raw, file);
      } catch {
        continue; // skip malformed specs rather than break the whole board
      }
      const m = meta[parsed.frontmatter.id] ?? {};
      features.push({
        specId: parsed.frontmatter.id,
        title: parsed.frontmatter.title,
        kind: parsed.frontmatter.kind,
        level: leafKey,
        isDbNative: false,
        productId: m.productId ?? defaultProductId,
        status: m.status ?? firstStage,
        rank: m.rank ?? null,
        tags: m.tags ?? [],
        releaseId: m.releaseId ?? null,
        cycleId: m.cycleId ?? null,
        assigneeId: m.assigneeId ?? null,
        assigneeName: null, // no user records in local file mode
        customFields: m.customFields ?? {},
        ...riceFields({
          riceReach: m.riceReach ?? null,
          riceImpact: m.riceImpact ?? null,
          riceConfidence: m.riceConfidence ?? null,
          riceEffort: m.riceEffort ?? null,
        }),
        path: path.relative(this.root, file),
        content: parsed.content,
        // Local file mode has no remote to race against, and no blob shas: the
        // file on disk is the only copy there is.
        blobSha: null,
        sections: parsed.sections,
        relations: [],
        blocksCount: 0,
        blockedByCount: 0,
        parentSpecId: m.parentSpecId ?? null,
        parentTitle: null,
        children: [],
        childCount: 0,
        childDoneCount: 0,
        githubSummary: emptyGithubSummary(),
        githubLinks: [],
      });
    }
    // DB-native items (initiatives/epics) — no spec/content; merged into the
    // same set so hierarchy roll-ups span all levels.
    for (const item of items) {
      features.push({
        specId: item.id,
        title: item.title,
        level: item.level,
        isDbNative: true,
        productId: item.productId ?? defaultProductId,
        status: item.status,
        rank: null,
        tags: item.tags ?? [],
        releaseId: item.releaseId ?? null,
        cycleId: item.cycleId ?? null,
        assigneeId: item.assigneeId,
        assigneeName: null,
        customFields: item.customFields ?? {},
        ...riceFields({
          riceReach: item.riceReach ?? null,
          riceImpact: item.riceImpact ?? null,
          riceConfidence: item.riceConfidence ?? null,
          riceEffort: item.riceEffort ?? null,
        }),
        path: "",
        content: item.details ?? "",
        blobSha: null,
        sections: [],
        relations: [],
        blocksCount: 0,
        blockedByCount: 0,
        parentSpecId: item.parentSpecId ?? null,
        parentTitle: null,
        children: [],
        childCount: 0,
        childDoneCount: 0,
        githubSummary: emptyGithubSummary(),
        githubLinks: [],
      });
    }
    this.attachRelations(features, meta);
    this.attachHierarchy(features);
    return features;
  }

  /** Resolve parent titles + direct children + roll-up counts. */
  private attachHierarchy(features: FeatureDetail[]): void {
    const bySpec = new Map(features.map((f) => [f.specId, f]));
    for (const f of features) {
      // Drop a parent pointer to a spec that no longer exists.
      const parent = f.parentSpecId ? bySpec.get(f.parentSpecId) : undefined;
      if (!parent) {
        f.parentSpecId = null;
        continue;
      }
      f.parentTitle = parent.title;
      parent.children.push({
        specId: f.specId,
        title: f.title,
        status: f.status,
      });
      parent.childCount += 1;
      if (isDone(f.status)) parent.childDoneCount += 1;
    }
  }

  /** Resolve stored edges into per-feature relations + blocked counts. */
  private attachRelations(features: FeatureDetail[], meta: MetadataFile): void {
    const titleBySpec = new Map(features.map((f) => [f.specId, f.title]));
    const levelBySpec = new Map(features.map((f) => [f.specId, f.level]));
    const bySpec = new Map(features.map((f) => [f.specId, f]));
    for (const [fromSpec, m] of Object.entries(meta)) {
      for (const link of m.links ?? []) {
        const from = bySpec.get(fromSpec);
        const to = bySpec.get(link.to);
        if (from && titleBySpec.has(link.to)) {
          from.relations.push({
            id: localLinkId(fromSpec, link),
            direction: localDirection(fromSpec, link.type, fromSpec),
            otherSpecId: link.to,
            otherTitle: titleBySpec.get(link.to)!,
            otherLevel: levelBySpec.get(link.to)!,
          });
          if (link.type === "blocks") from.blocksCount += 1;
        }
        if (to && titleBySpec.has(fromSpec)) {
          to.relations.push({
            id: localLinkId(fromSpec, link),
            direction: localDirection(fromSpec, link.type, link.to),
            otherSpecId: fromSpec,
            otherTitle: titleBySpec.get(fromSpec)!,
            otherLevel: levelBySpec.get(fromSpec)!,
          });
          if (link.type === "blocks") to.blockedByCount += 1;
        }
      }
    }
  }

  // ==========================================================================
  // Items: read and update
  //
  // `updateFeature` is here rather than with the other writes below, which is
  // the opposite of `db.ts`. The two implementations of one interface do not
  // present their methods in the same order.
  // ==========================================================================

  // The local store has a single implicit workspace, so `scope` is ignored.
  async listFeatures(_scope?: WorkspaceScope): Promise<FeatureRecord[]> {
    return this.loadAll();
  }

  async listFeatureBodies(
    specIds: readonly string[],
    _scope?: WorkspaceScope,
  ): Promise<Map<string, string>> {
    if (specIds.length === 0) return new Map();
    const wanted = new Set(specIds);
    const all = await this.loadAll();
    const out = new Map<string, string>();
    for (const f of all) {
      if (wanted.has(f.specId) && f.content) out.set(f.specId, f.content);
    }
    return out;
  }

  async getFeature(
    specId: string,
    _scope?: WorkspaceScope,
  ): Promise<FeatureDetail | null> {
    const all = await this.loadAll();
    return all.find((f) => f.specId === specId) ?? null;
  }

  async updateFeature(
    specId: string,
    patch: FeaturePatch,
    _scope?: WorkspaceScope,
    _emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
  ): Promise<void> {
    // DB-native items live in their own file, not the spec-metadata map.
    const items = await this.readItems();
    const idx = items.findIndex((i) => i.id === specId);
    if (idx >= 0) {
      const it = items[idx]!;
      if (patch.title !== undefined) it.title = patch.title;
      if (patch.status !== undefined) it.status = patch.status;
      if (patch.tags !== undefined) it.tags = patch.tags;
      if (patch.releaseId !== undefined) it.releaseId = patch.releaseId;
      if (patch.assigneeId !== undefined) it.assigneeId = patch.assigneeId;
      if (patch.parentSpecId !== undefined)
        it.parentSpecId = patch.parentSpecId;
      if (patch.details !== undefined)
        it.details = patch.details?.trim() ? patch.details : null;
      if (patch.riceReach !== undefined) it.riceReach = patch.riceReach;
      if (patch.riceImpact !== undefined) it.riceImpact = patch.riceImpact;
      if (patch.riceConfidence !== undefined)
        it.riceConfidence = patch.riceConfidence;
      if (patch.riceEffort !== undefined) it.riceEffort = patch.riceEffort;
      await this.writeItems(items);
      return;
    }
    const meta = await this.readMetadata();
    meta[specId] = { ...meta[specId], ...patch };
    await this.writeMetadata(meta);
  }

  // ==========================================================================
  // Workspace levels
  // ==========================================================================

  async listLevels(_scope?: WorkspaceScope): Promise<WorkspaceLevel[]> {
    // Persisted config if present, else the default hierarchy.
    return resolveLevels(await this.readLevels());
  }

  async updateLevels(
    updates: LevelUpdate[],
    _scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    const current = resolveLevels(await this.readLevels());
    let resolved;
    try {
      resolved = resolveLevelUpdate(current, updates);
    } catch (err) {
      throw new LevelError(
        err instanceof Error ? err.message : "Invalid levels.",
      );
    }
    if (resolved.removedKeys.length > 0) {
      const items = await this.readItems();
      const used = items.find((i) => resolved.removedKeys.includes(i.level));
      if (used) {
        throw new LevelError(
          `Can't remove the "${used.level}" level while items still use it.`,
        );
      }
    }
    await this.writeLevels(resolved.levels);
    return resolved.levels;
  }

  async updateLevelFields(
    fields: Record<string, string[] | null>,
    _scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    const current = resolveLevels(await this.readLevels());
    const known = new Set(current.map((l) => l.key));
    for (const key of Object.keys(fields)) {
      if (!known.has(key)) throw new LevelError(`Unknown level: ${key}`);
    }
    const updated = current.map((l) =>
      Object.prototype.hasOwnProperty.call(fields, l.key)
        ? { ...l, fields: fields[l.key] ?? null }
        : l,
    );
    await this.writeLevels(updated);
    return updated;
  }

  // ==========================================================================
  // Items: write, relations, GitHub links, and the event ledger
  // ==========================================================================

  async createFeature(
    input: CreateFeatureInput,
    _scope?: WorkspaceScope,
    _emitType?: string, // webhooks are DB-only; ignored in local file mode
  ): Promise<FeatureRecord> {
    const levels = resolveLevels();
    const title = input.title.trim();
    if (!title) throw new FeatureError("Title is required.");
    if (!levels.some((l) => l.key === input.level))
      throw new FeatureError(`Unknown level: ${input.level}`);
    // Leaf-level items are creatable here too: a spec is an attachment, not an
    // identity, so a work item with no spec is a first-class row (ADR 0003).

    if (input.parentSpecId) {
      const all = await this.loadAll();
      const parent = all.find((f) => f.specId === input.parentSpecId);
      if (!parent)
        throw new FeatureError(`Unknown parent: ${input.parentSpecId}`);
      if (!isValidParentLevel(input.level, parent.level, levels))
        throw new FeatureError(
          `A ${input.level} can't sit under a ${parent.level}.`,
        );
    } else if (!isValidParentLevel(input.level, null, levels)) {
      throw new FeatureError(`A ${input.level} requires a parent.`);
    }

    const id = randomUUID();
    const productId = input.productId ?? (await this.defaultProductId());
    // Mirror the DB store: a release must exist and be a portfolio release or
    // one scoped to this item's product.
    if (input.releaseId) {
      const release = (await this.readReleases()).find(
        (r) => r.id === input.releaseId,
      );
      if (!release) {
        throw new FeatureError(`Unknown release: ${input.releaseId}`);
      }
      const releaseProductId = release.productId ?? null;
      if (releaseProductId !== null && releaseProductId !== productId) {
        throw new FeatureError("Release belongs to a different product.");
      }
    }
    // Cycles follow the same rule on their own axis.
    if (input.cycleId) {
      const cycle = (await this.readCycles()).find((c) => c.id === input.cycleId);
      if (!cycle) throw new FeatureError(`Unknown cycle: ${input.cycleId}`);
      const cycleProductId = cycle.productId ?? null;
      if (cycleProductId !== null && cycleProductId !== productId) {
        throw new FeatureError("Cycle belongs to a different product.");
      }
    }
    const item: LocalItem = {
      id,
      title,
      level: input.level,
      status: input.status ?? "backlog",
      assigneeId: input.assigneeId ?? null,
      tags: input.tags ?? [],
      parentSpecId: input.parentSpecId ?? null,
      releaseId: input.releaseId ?? null,
      cycleId: input.cycleId ?? null,
      productId,
      details: input.details?.trim() ? input.details : null,
      customFields: input.customFields ?? {},
    };
    const items = await this.readItems();
    await this.writeItems([...items, item]);

    return {
      specId: id,
      title,
      level: item.level,
      isDbNative: true,
      productId,
      status: item.status,
      rank: null,
      tags: item.tags,
      releaseId: item.releaseId ?? null,
      cycleId: item.cycleId ?? null,
      assigneeId: item.assigneeId,
      customFields: item.customFields ?? {},
      ...riceFields({
        riceReach: null,
        riceImpact: null,
        riceConfidence: null,
        riceEffort: null,
      }),
      path: "",
      blocksCount: 0,
      blockedByCount: 0,
      parentSpecId: item.parentSpecId,
      childCount: 0,
      childDoneCount: 0,
      githubSummary: emptyGithubSummary(),
    } satisfies FeatureRecord;
  }

  async deleteFeature(
    specId: string,
    _scope?: WorkspaceScope,
    _emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
    opts?: DeleteFeatureOptions,
  ): Promise<void> {
    const items = await this.readItems();
    if (items.some((i) => i.id === specId)) {
      // No spec attached: an ordinary delete of the tracking record.
      await this.writeItems(items.filter((i) => i.id !== specId));
      return;
    }
    // Otherwise it's a spec file. Deleting the record without the file would
    // just re-read it on the next load, so the file goes too (ADR 0003 D4).
    // This store owns the working tree, so it performs the removal itself
    // rather than relying on a caller's prior git delete.
    const all = await this.loadAll();
    const feature = all.find((f) => f.specId === specId);
    if (!feature) throw new FeatureError(`Unknown work item: ${specId}`);
    if (!opts?.specRemoved) {
      throw new FeatureError(
        "This work item has a spec attached. Deleting it also deletes " +
          `${feature.path}; pass removeSpec to confirm.`,
      );
    }
    await fs.rm(path.join(this.root, feature.path), { force: true });
    // Drop the item's sidecar metadata so a same-id spec restored later starts
    // clean rather than inheriting a deleted item's status.
    const meta = await this.readMetadata();
    delete meta[specId];
    await this.writeMetadata(meta);
  }

  /**
   * No-op in local file mode. Auto-created Feature groupings only ever come
   * from GitHub sync, which is DB-only, so this store can never hold one.
   */
  async pruneAutoGrouping(
    _specId: string,
    _scope?: WorkspaceScope,
  ): Promise<boolean> {
    return false;
  }

  async addRelation(
    specId: string,
    input: RelationInput,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    if (specId === input.toSpecId)
      throw new RelationError("A feature cannot relate to itself.");
    const all = await this.loadAll();
    const known = new Set(all.map((f) => f.specId));
    if (!known.has(specId))
      throw new RelationError(`Unknown feature: ${specId}`);
    if (!known.has(input.toSpecId))
      throw new RelationError(`Unknown related feature: ${input.toSpecId}`);

    const { from, link } = toLocalEdge(specId, input.toSpecId, input.direction);
    const meta = await this.readMetadata();

    // Reject a contradictory cycle (A blocks B while B blocks A).
    if (link.type === "blocks") {
      const reverse = (meta[link.to]?.links ?? []).some(
        (l) => l.type === "blocks" && l.to === from,
      );
      if (reverse)
        throw new RelationError(
          "That would create a circular blocking dependency.",
        );
    }

    const existing = meta[from]?.links ?? [];
    // Symmetric relates_to: skip if the inverse edge already exists.
    const inverseExists =
      link.type === "relates_to" &&
      (meta[link.to]?.links ?? []).some(
        (l) => l.type === "relates_to" && l.to === from,
      );
    const duplicate = existing.some(
      (l) => l.to === link.to && l.type === link.type,
    );
    if (!duplicate && !inverseExists) {
      meta[from] = { ...meta[from], links: [...existing, link] };
      await this.writeMetadata(meta);
    }
  }

  async removeRelation(
    _specId: string,
    linkId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    // linkId is `${fromSpec}:${toSpec}:${type}` (see localLinkId).
    const [fromSpec, toSpec, type] = linkId.split(":");
    if (!fromSpec || !toSpec || !type) return;
    const meta = await this.readMetadata();
    const links = meta[fromSpec]?.links;
    if (!links) return;
    meta[fromSpec] = {
      ...meta[fromSpec],
      links: links.filter((l) => !(l.to === toSpec && l.type === type)),
    };
    await this.writeMetadata(meta);
  }

  // GitHub linking requires a connected GitHub App, which file mode doesn't
  // have. Reads return nothing (see loadAll); writes are rejected clearly.
  async addGithubLink(
    _specId: string,
    _link: ResolvedGithubLink,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    throw new RelationError(
      "GitHub linking requires a connected repository (not available in local file mode).",
    );
  }

  async removeGithubLink(
    _specId: string,
    _linkId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    // Nothing to remove in file mode.
  }

  /**
   * File mode keeps no change ledger. There is one implicit user and no
   * database to append to, and the specs themselves are files in a git working
   * tree, so their history is already the user's own `git log`.
   */
  async listItemEvents(
    _specId: string,
    _scope?: WorkspaceScope,
    _limit?: number,
  ): Promise<ItemEvent[]> {
    return [];
  }

  /** Nothing is recorded in file mode, so there is nothing to report on. */
  async itemActivitySummary(
    _query: ActivityQuery,
    _scope?: WorkspaceScope,
  ): Promise<ActivitySummary> {
    return { since: null, total: 0, byActor: [], byField: [], byDay: [], stageTime: [] };
  }

  // Saved views persist to `.specboards/local-views.json`. There's a single
  // implicit user in local mode, so no per-user scoping.
  private async readViews(): Promise<SavedView[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.viewsPath, "utf8"),
      ) as SavedView[];
    } catch {
      return [];
    }
  }

  private async writeViews(views: SavedView[]): Promise<void> {
    await fs.mkdir(path.dirname(this.viewsPath), { recursive: true });
    await fs.writeFile(
      this.viewsPath,
      JSON.stringify(views, null, 2) + "\n",
      "utf8",
    );
  }

  // ==========================================================================
  // Saved views and board preferences
  // ==========================================================================

  async listSavedViews(_scope?: WorkspaceScope): Promise<SavedView[]> {
    return this.readViews();
  }

  async createSavedView(
    input: SavedViewInput,
    _scope?: WorkspaceScope,
  ): Promise<SavedView> {
    const views = await this.readViews();
    const view: SavedView = {
      id: randomUUID(),
      name: input.name,
      view: input.view,
      filters: input.filters,
    };
    await this.writeViews([view, ...views]); // newest first, matching db order
    return view;
  }

  async updateSavedView(
    id: string,
    patch: SavedViewPatch,
    _scope?: WorkspaceScope,
  ): Promise<SavedView | null> {
    const views = await this.readViews();
    const existing = views.find((v) => v.id === id);
    if (!existing) return null;
    const updated: SavedView = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.filters !== undefined ? { filters: patch.filters } : {}),
    };
    await this.writeViews(views.map((v) => (v.id === id ? updated : v)));
    return updated;
  }

  async deleteSavedView(id: string, _scope?: WorkspaceScope): Promise<void> {
    const views = await this.readViews();
    await this.writeViews(views.filter((v) => v.id !== id));
  }

  // Board preferences persist to `.specboards/local-board-prefs.json` as a map
  // keyed by board ("backlog"/"roadmap"). Single implicit user in local mode,
  // so no per-user scoping. A legacy flat file (pre per-board prefs) is read as
  // the Backlog's prefs and rewritten into the map on the next save.
  private async readBoardPrefsMap(): Promise<
    Partial<Record<BoardKey, BoardPreferences>>
  > {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.boardPrefsPath, "utf8"),
      ) as BoardPreferences | Partial<Record<BoardKey, BoardPreferences>>;
      if (parsed && ("cardFields" in parsed || "featured" in parsed)) {
        return { backlog: parsed as BoardPreferences };
      }
      return (parsed ?? {}) as Partial<Record<BoardKey, BoardPreferences>>;
    } catch {
      return {};
    }
  }

  async getBoardPreferences(
    _scope?: WorkspaceScope,
    board: BoardKey = "backlog",
  ): Promise<BoardPreferences | null> {
    const map = await this.readBoardPrefsMap();
    return map[board] ?? null;
  }

  async setBoardPreferences(
    prefs: BoardPreferences,
    _scope?: WorkspaceScope,
    board: BoardKey = "backlog",
  ): Promise<void> {
    const map = await this.readBoardPrefsMap();
    map[board] = prefs;
    await fs.mkdir(path.dirname(this.boardPrefsPath), { recursive: true });
    await fs.writeFile(
      this.boardPrefsPath,
      JSON.stringify(map, null, 2) + "\n",
      "utf8",
    );
  }

  // Custom properties persist to `.specboards/local-properties.json`.
  private async readProperties(): Promise<PropertyDef[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.propertiesPath, "utf8"),
      ) as PropertyDef[];
    } catch {
      return [];
    }
  }

  private async writeProperties(rows: PropertyDef[]): Promise<void> {
    await fs.mkdir(path.dirname(this.propertiesPath), { recursive: true });
    await fs.writeFile(
      this.propertiesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  // ==========================================================================
  // Custom properties and detail templates
  //
  // `listPropertiesUnion` and `listStatusesUnion` are NOT here: they sit far
  // below, next to `getTransitionMode`. In `db.ts` they are in this block.
  // ==========================================================================

  async listProperties(
    _scope?: WorkspaceScope,
    entity?: PropertyEntity,
  ): Promise<PropertyDef[]> {
    // Default `entity` for rows written before the discriminator existed.
    const rows = (await this.readProperties()).map((p) => ({
      ...p,
      entity: p.entity ?? "item",
    }));
    const filtered = entity ? rows.filter((p) => p.entity === entity) : rows;
    return filtered.sort((a, b) => a.position - b.position);
  }

  async createProperty(
    input: PropertyInput,
    _scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    const label = input.label.trim();
    if (!label) throw new PropertyError("Property label is required.");
    if (!isPropertyType(input.type)) {
      throw new PropertyError(`Unknown property type: ${String(input.type)}`);
    }
    const entity: PropertyEntity = input.entity ?? "item";
    const rows = await this.readProperties();
    // Keys and positions are scoped per entity (see the db store).
    const sameEntity = rows.filter((p) => (p.entity ?? "item") === entity);
    const property: PropertyDef = {
      id: randomUUID(),
      key: propertyKeyFromLabel(label, new Set(sameEntity.map((p) => p.key))),
      label,
      type: input.type,
      entity,
      options: localNormalizeOptions(input.type, input.options),
      levels: entity === "release" ? null : (input.levels ?? null),
      position: sameEntity.reduce((m, p) => Math.max(m, p.position), -1) + 1,
    };
    await this.writeProperties([...rows, property]);
    return property;
  }

  async updateProperty(
    id: string,
    patch: PropertyPatch,
    _scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    const rows = await this.readProperties();
    const property = rows.find((p) => p.id === id);
    if (!property) throw new PropertyError(`Unknown property: ${id}`);
    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label) throw new PropertyError("Property label is required.");
      property.label = label;
    }
    if (patch.options !== undefined) {
      property.options = localNormalizeOptions(property.type, patch.options);
    }
    if (patch.levels !== undefined) property.levels = patch.levels;
    if (patch.position !== undefined) property.position = patch.position;
    await this.writeProperties(rows);
    return property;
  }

  async deleteProperty(id: string, _scope?: WorkspaceScope): Promise<void> {
    const rows = await this.readProperties();
    if (!rows.some((p) => p.id === id))
      throw new PropertyError(`Unknown property: ${id}`);
    await this.writeProperties(rows.filter((p) => p.id !== id));
  }

  // Detail templates persist to `.specboards/local-detail-templates.json`.
  private async readTemplates(): Promise<DetailTemplate[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.templatesPath, "utf8"),
      ) as DetailTemplate[];
    } catch {
      return [];
    }
  }

  private async writeTemplates(rows: DetailTemplate[]): Promise<void> {
    await fs.mkdir(path.dirname(this.templatesPath), { recursive: true });
    await fs.writeFile(
      this.templatesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  async listDetailTemplates(
    _scope?: WorkspaceScope,
  ): Promise<DetailTemplate[]> {
    const rows = await this.readTemplates();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createDetailTemplate(
    input: DetailTemplateInput,
    _scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    const name = input.name.trim();
    if (!name) throw new DetailTemplateError("Template name is required.");
    const rows = await this.readTemplates();
    if (rows.some((t) => t.name === name))
      throw new DetailTemplateError(
        `A template named "${name}" already exists.`,
      );
    const template: DetailTemplate = {
      id: randomUUID(),
      name,
      body: input.body ?? "",
    };
    await this.writeTemplates([...rows, template]);
    return template;
  }

  async updateDetailTemplate(
    id: string,
    patch: DetailTemplatePatch,
    _scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    const rows = await this.readTemplates();
    const template = rows.find((t) => t.id === id);
    if (!template) throw new DetailTemplateError(`Unknown template: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new DetailTemplateError("Template name is required.");
      if (rows.some((t) => t.id !== id && t.name === name))
        throw new DetailTemplateError(
          `A template named "${name}" already exists.`,
        );
      template.name = name;
    }
    if (patch.body !== undefined) template.body = patch.body;
    await this.writeTemplates(rows);
    return template;
  }

  async deleteDetailTemplate(
    id: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    const rows = await this.readTemplates();
    if (!rows.some((t) => t.id === id))
      throw new DetailTemplateError(`Unknown template: ${id}`);
    await this.writeTemplates(rows.filter((t) => t.id !== id));
    // Clear the pointer from any level that referenced it.
    const levels = resolveLevels(await this.readLevels());
    if (levels.some((l) => l.detailTemplateId === id)) {
      await this.writeLevels(
        levels.map((l) =>
          l.detailTemplateId === id ? { ...l, detailTemplateId: null } : l,
        ),
      );
    }
  }

  async updateLevelTemplates(
    templates: Record<string, string | null>,
    _scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    const current = resolveLevels(await this.readLevels());
    const known = new Set(current.map((l) => l.key));
    for (const key of Object.keys(templates)) {
      if (!known.has(key)) throw new LevelError(`Unknown level: ${key}`);
    }
    const templateIds = new Set((await this.readTemplates()).map((t) => t.id));
    for (const value of Object.values(templates)) {
      if (value && !templateIds.has(value))
        throw new LevelError(`Unknown detail template: ${value}`);
    }
    const updated = current.map((l) =>
      Object.prototype.hasOwnProperty.call(templates, l.key)
        ? { ...l, detailTemplateId: templates[l.key] ?? null }
        : l,
    );
    await this.writeLevels(updated);
    return updated;
  }

  // ==========================================================================
  // Statuses and stage gates
  // ==========================================================================

  // Releases persist to `.specboards/local-releases.json`.
  async listStatuses(_scope?: WorkspaceScope): Promise<WorkspaceStatus[]> {
    try {
      const rows = JSON.parse(
        await fs.readFile(this.statusesPath, "utf8"),
      ) as WorkspaceStatus[];
      return rows
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((r, i) => ({ ...r, position: i }));
    } catch {
      return [];
    }
  }

  async replaceStatuses(
    stages: StatusStageInput[],
    _scope?: WorkspaceScope,
  ): Promise<WorkspaceStatus[]> {
    const rows: WorkspaceStatus[] = stages.map((s, i) => ({
      key: s.key,
      label: s.label,
      position: i,
    }));
    await fs.mkdir(path.dirname(this.statusesPath), { recursive: true });
    await fs.writeFile(
      this.statusesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );

    // What is in force after the write. An empty set means no stages are
    // configured, and the board falls back to the built-in vocabulary, so that
    // is what the keys below have to be measured against. `archived` stays
    // valid either way so archived items keep working.
    const effective =
      rows.length > 0
        ? rows.map((r) => r.key)
        : DEFAULT_STATUSES.filter((s) => s !== "archived");
    const fallback = effective[0]!;
    const validKeys = new Set<string>([...effective, "archived"]);

    // Re-home any item left in a stage that no longer exists, matching the db
    // store. Without this a removed stage leaves work on a board that draws no
    // column for it, reachable only by editing the JSON by hand.
    //
    // Two places hold a status here and both have to be swept: DB-native items
    // carry theirs in the items file, and a spec-backed item carries its own in
    // the metadata map. `loadAll` resolves an absent entry to the first stage,
    // so a spec that was never moved needs no row written for it.
    const items = await this.readItems();
    const movedItems = items.filter((i) => !validKeys.has(i.status));
    if (movedItems.length > 0) {
      for (const item of movedItems) item.status = fallback;
      await this.writeItems(items);
    }

    const meta = await this.readMetadata();
    let metaChanged = false;
    for (const entry of Object.values(meta)) {
      if (entry?.status !== undefined && !validKeys.has(entry.status)) {
        entry.status = fallback;
        metaChanged = true;
      }
    }
    if (metaChanged) await this.writeMetadata(meta);

    // Drop gates (and their completions) whose stage was removed, mirroring the
    // db store.
    const gates = await this.listStageGates();
    const kept = gates.filter((g) => validKeys.has(g.stageKey));
    if (kept.length !== gates.length) {
      await this.replaceStageGates(
        kept.map((g) => ({ id: g.id, stageKey: g.stageKey, label: g.label })),
      );
    }
    return rows;
  }

  // Stage gates persist to `.specboards/local-stage-gates.json`; per-item
  // completions to `.specboards/local-gate-completions.json`.
  async listStageGates(_scope?: WorkspaceScope): Promise<StageGate[]> {
    try {
      const rows = JSON.parse(
        await fs.readFile(this.stageGatesPath, "utf8"),
      ) as StageGate[];
      return rows
        .slice()
        .sort(
          (a, b) =>
            a.stageKey.localeCompare(b.stageKey) || a.position - b.position,
        );
    } catch {
      return [];
    }
  }

  async replaceStageGates(
    gates: StageGateInput[],
    _scope?: WorkspaceScope,
  ): Promise<StageGate[]> {
    // Reconcile by id so kept gates retain their ids (and completions); only
    // gates dropped from the new set lose theirs.
    const existingIds = new Set((await this.listStageGates()).map((g) => g.id));
    const perStage = new Map<string, number>();
    const rows: StageGate[] = gates.map((g) => {
      const pos = perStage.get(g.stageKey) ?? 0;
      perStage.set(g.stageKey, pos + 1);
      const id = g.id && existingIds.has(g.id) ? g.id : randomUUID();
      return { id, stageKey: g.stageKey, label: g.label, position: pos };
    });
    const sorted = rows
      .slice()
      .sort(
        (a, b) =>
          a.stageKey.localeCompare(b.stageKey) || a.position - b.position,
      );
    await fs.mkdir(path.dirname(this.stageGatesPath), { recursive: true });
    await fs.writeFile(
      this.stageGatesPath,
      JSON.stringify(sorted, null, 2) + "\n",
      "utf8",
    );
    // Drop completions whose gate no longer exists.
    const valid = new Set(sorted.map((r) => r.id));
    const completions = await this.readGateCompletions();
    let changed = false;
    for (const [specId, ids] of Object.entries(completions)) {
      const kept = ids.filter((id) => valid.has(id));
      if (kept.length !== ids.length) {
        changed = true;
        if (kept.length === 0) delete completions[specId];
        else completions[specId] = kept;
      }
    }
    if (changed) await this.writeGateCompletions(completions);
    return sorted;
  }

  private async readGateCompletions(): Promise<Record<string, string[]>> {
    try {
      return JSON.parse(
        await fs.readFile(this.gateCompletionsPath, "utf8"),
      ) as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  private async writeGateCompletions(
    map: Record<string, string[]>,
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.gateCompletionsPath), { recursive: true });
    await fs.writeFile(
      this.gateCompletionsPath,
      JSON.stringify(map, null, 2) + "\n",
      "utf8",
    );
  }

  async listGateCompletions(
    specId: string,
    _scope?: WorkspaceScope,
  ): Promise<string[]> {
    const map = await this.readGateCompletions();
    return map[specId] ?? [];
  }

  async setGateCompletion(
    specId: string,
    gateId: string,
    completed: boolean,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    const gates = await this.listStageGates();
    if (!gates.some((g) => g.id === gateId)) {
      throw new StageGateError("Unknown stage gate.");
    }
    const map = await this.readGateCompletions();
    const current = new Set(map[specId] ?? []);
    if (completed) current.add(gateId);
    else current.delete(gateId);
    if (current.size === 0) delete map[specId];
    else map[specId] = [...current];
    await this.writeGateCompletions(map);
  }

  private async readReleases(): Promise<LocalRelease[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.releasesPath, "utf8"),
      ) as LocalRelease[];
    } catch {
      return [];
    }
  }

  private async writeReleases(rows: LocalRelease[]): Promise<void> {
    await fs.mkdir(path.dirname(this.releasesPath), { recursive: true });
    await fs.writeFile(
      this.releasesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  // ==========================================================================
  // Releases
  // ==========================================================================

  async listReleases(_scope?: WorkspaceScope): Promise<ReleaseRecord[]> {
    const [rows, all] = await Promise.all([
      this.readReleases(),
      this.loadAll(),
    ]);
    const counts = new Map<string, number>();
    for (const f of all) {
      if (f.releaseId)
        counts.set(f.releaseId, (counts.get(f.releaseId) ?? 0) + 1);
    }
    return rows
      .map((r) => ({
        ...r,
        productId: r.productId ?? null,
        shippedDate: r.shippedDate ?? null,
        notes: r.notes ?? null,
        releaseNotesMode: r.releaseNotesMode ?? "none",
        releaseNotesBody: r.releaseNotesBody ?? null,
        releaseNotesUrl: r.releaseNotesUrl ?? null,
        customFields: r.customFields ?? {},
        itemCount: counts.get(r.id) ?? 0,
      }))
      .sort(compareReleases);
  }

  async createRelease(
    input: ReleaseInput,
    _scope?: WorkspaceScope,
  ): Promise<ReleaseRecord> {
    const name = input.name.trim();
    if (!name) throw new ReleaseError("Release name is required.");
    const productId = input.productId ?? null;
    const rows = await this.readReleases();
    // Names are unique within a product (and within the portfolio scope).
    if (rows.some((r) => r.name === name && (r.productId ?? null) === productId)) {
      throw new ReleaseError(`A release named "${name}" already exists.`);
    }
    const status = input.status ?? "planned";
    if (!(RELEASE_STATUSES as readonly string[]).includes(status)) {
      throw new ReleaseError(`Unknown release status: ${status}`);
    }
    const release: LocalRelease = {
      id: randomUUID(),
      name,
      productId,
      status,
      startDate: input.startDate ?? null,
      targetDate: input.targetDate ?? null,
      shippedDate: null,
      notes: input.notes ?? null,
      releaseNotesMode: input.releaseNotesMode ?? "none",
      releaseNotesBody: input.releaseNotesBody ?? null,
      releaseNotesUrl: input.releaseNotesUrl ?? null,
      customFields: input.customFields ?? {},
    };
    await this.writeReleases([...rows, release]);
    return {
      ...release,
      productId,
      shippedDate: release.shippedDate ?? null,
      notes: release.notes ?? null,
      releaseNotesMode: release.releaseNotesMode ?? "none",
      releaseNotesBody: release.releaseNotesBody ?? null,
      releaseNotesUrl: release.releaseNotesUrl ?? null,
      customFields: release.customFields ?? {},
      itemCount: 0,
    };
  }

  async updateRelease(
    id: string,
    patch: ReleasePatch,
    _scope?: WorkspaceScope,
    _emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
  ): Promise<ReleaseRecord> {
    const rows = await this.readReleases();
    const release = rows.find((r) => r.id === id);
    if (!release) throw new ReleaseError(`Unknown release: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ReleaseError("Release name is required.");
      release.name = name;
    }
    if (patch.status !== undefined) {
      if (!(RELEASE_STATUSES as readonly string[]).includes(patch.status)) {
        throw new ReleaseError(`Unknown release status: ${patch.status}`);
      }
      const prevStatus = release.status;
      release.status = patch.status;
      // Stamp the actual ship date on first ship; clear it on reopen. Planned
      // dates are retained.
      if (patch.status === "shipped" && prevStatus !== "shipped") {
        if (!release.shippedDate) {
          release.shippedDate = new Date().toISOString().slice(0, 10);
        }
      } else if (patch.status !== "shipped" && prevStatus === "shipped") {
        release.shippedDate = null;
      }
    }
    if (patch.startDate !== undefined) release.startDate = patch.startDate;
    if (patch.targetDate !== undefined) release.targetDate = patch.targetDate;
    if (patch.notes !== undefined) release.notes = patch.notes;
    if (patch.releaseNotesMode !== undefined)
      release.releaseNotesMode = patch.releaseNotesMode;
    if (patch.releaseNotesBody !== undefined)
      release.releaseNotesBody = patch.releaseNotesBody;
    if (patch.releaseNotesUrl !== undefined)
      release.releaseNotesUrl = patch.releaseNotesUrl;
    if (patch.customFields !== undefined)
      release.customFields = patch.customFields;
    if (patch.productId !== undefined) {
      const targetProductId = patch.productId;
      if (
        rows.some(
          (r) =>
            r.id !== id &&
            r.name === release.name &&
            (r.productId ?? null) === targetProductId,
        )
      ) {
        throw new ReleaseError(
          `A release named "${release.name}" already exists.`,
        );
      }
      release.productId = targetProductId;
    }
    await this.writeReleases(rows);
    const all = await this.loadAll();
    return {
      ...release,
      productId: release.productId ?? null,
      shippedDate: release.shippedDate ?? null,
      notes: release.notes ?? null,
      releaseNotesMode: release.releaseNotesMode ?? "none",
      releaseNotesBody: release.releaseNotesBody ?? null,
      releaseNotesUrl: release.releaseNotesUrl ?? null,
      customFields: release.customFields ?? {},
      itemCount: all.filter((f) => f.releaseId === id).length,
    };
  }

  async deleteRelease(id: string, _scope?: WorkspaceScope): Promise<void> {
    const rows = await this.readReleases();
    if (!rows.some((r) => r.id === id))
      throw new ReleaseError(`Unknown release: ${id}`);
    await this.writeReleases(rows.filter((r) => r.id !== id));
    // Unschedule the deleted release's items (mirrors the DB's SET NULL).
    const items = await this.readItems();
    let itemsChanged = false;
    for (const item of items) {
      if (item.releaseId === id) {
        item.releaseId = null;
        itemsChanged = true;
      }
    }
    if (itemsChanged) await this.writeItems(items);
    const meta = await this.readMetadata();
    let metaChanged = false;
    for (const m of Object.values(meta)) {
      if (m.releaseId === id) {
        m.releaseId = null;
        metaChanged = true;
      }
    }
    if (metaChanged) await this.writeMetadata(meta);
  }

  // ── Cycles ────────────────────────────────────────────────────────────
  // Persisted to `.specboards/local-cycles.json`. File mode has no product
  // roles, so the per-product write checks the DB store makes are absent here;
  // every other rule (name uniqueness per scope, date validation, unscheduling
  // on delete, done work staying put on rollover) is the same.

  private async readCycles(): Promise<LocalCycle[]> {
    return this.readJsonFile<LocalCycle>(this.cyclesPath);
  }

  private async writeCycles(rows: LocalCycle[]): Promise<void> {
    await fs.mkdir(path.dirname(this.cyclesPath), { recursive: true });
    await fs.writeFile(
      this.cyclesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  /** Set `cycleId` on every item/metadata row matching `match`, returning how
   * many changed. Both stores of item state have to move together in file mode. */
  private async retargetCycle(
    match: (current: string | null | undefined) => boolean,
    next: string | null,
    skipSpecIds?: Set<string>,
  ): Promise<number> {
    let moved = 0;
    const items = await this.readItems();
    let itemsChanged = false;
    for (const item of items) {
      if (!match(item.cycleId) || skipSpecIds?.has(item.id)) continue;
      item.cycleId = next;
      itemsChanged = true;
      moved += 1;
    }
    if (itemsChanged) await this.writeItems(items);

    const meta = await this.readMetadata();
    let metaChanged = false;
    for (const [specId, m] of Object.entries(meta)) {
      if (!match(m.cycleId) || skipSpecIds?.has(specId)) continue;
      m.cycleId = next;
      metaChanged = true;
      moved += 1;
    }
    if (metaChanged) await this.writeMetadata(meta);
    return moved;
  }

  // ==========================================================================
  // Cycles
  // ==========================================================================

  async listCycles(_scope?: WorkspaceScope): Promise<CycleRecord[]> {
    const [rows, all] = await Promise.all([this.readCycles(), this.loadAll()]);
    const totals = new Map<string, { items: number; done: number }>();
    for (const f of all) {
      if (!f.cycleId) continue;
      const acc = totals.get(f.cycleId) ?? { items: 0, done: 0 };
      acc.items += 1;
      if (isDone(f.status)) acc.done += 1;
      totals.set(f.cycleId, acc);
    }
    const today = todayDateOnly();
    return rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        productId: r.productId ?? null,
        startDate: r.startDate,
        endDate: r.endDate,
        notes: r.notes ?? null,
        state: cycleState(r, today),
        itemCount: totals.get(r.id)?.items ?? 0,
        doneCount: totals.get(r.id)?.done ?? 0,
      }))
      .sort((a, b) => compareCycles(a, b, today));
  }

  async createCycle(
    input: CycleInput,
    _scope?: WorkspaceScope,
  ): Promise<CycleRecord> {
    const name = input.name.trim();
    if (!name) throw new CycleError("Cycle name is required.");
    const dateError = validateCycleDates(input.startDate, input.endDate);
    if (dateError) throw new CycleError(dateError);
    const productId = input.productId ?? null;
    const rows = await this.readCycles();
    if (rows.some((c) => c.name === name && (c.productId ?? null) === productId)) {
      throw new CycleError(`A cycle named "${name}" already exists.`);
    }
    const cycle: LocalCycle = {
      id: randomUUID(),
      name,
      productId,
      startDate: input.startDate,
      endDate: input.endDate,
      notes: input.notes ?? null,
    };
    await this.writeCycles([...rows, cycle]);
    return {
      id: cycle.id,
      name,
      productId,
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      notes: cycle.notes ?? null,
      state: cycleState(cycle),
      itemCount: 0,
      doneCount: 0,
    };
  }

  async generateCycles(
    input: CycleGenerateInput,
    _scope?: WorkspaceScope,
  ): Promise<CycleRecord[]> {
    const error = validateCycleScheduleInput(input);
    if (error) throw new CycleError(error);
    const productId = input.productId ?? null;
    const planned = generateCycleSchedule(input);
    if (planned.length === 0) {
      throw new CycleError(
        "That start date, cycle length and end date produce no cycles.",
      );
    }
    const rows = await this.readCycles();
    // Check every name up front so the file is written once, all or nothing.
    // Local mode has no transaction, so a mid-run failure would otherwise
    // leave a partially generated schedule on disk.
    for (const p of planned) {
      if (
        rows.some(
          (c) => c.name === p.name && (c.productId ?? null) === productId,
        )
      ) {
        throw new CycleError(`A cycle named "${p.name}" already exists.`);
      }
    }
    const created: LocalCycle[] = planned.map((p) => ({
      id: randomUUID(),
      name: p.name,
      productId,
      startDate: p.startDate,
      endDate: p.endDate,
      notes: input.notes ?? null,
    }));
    await this.writeCycles([...rows, ...created]);
    return created.map((c) => ({
      id: c.id,
      name: c.name,
      productId,
      startDate: c.startDate,
      endDate: c.endDate,
      notes: c.notes ?? null,
      state: cycleState(c),
      itemCount: 0,
      doneCount: 0,
    }));
  }

  async updateCycle(
    id: string,
    patch: CyclePatch,
    _scope?: WorkspaceScope,
  ): Promise<CycleRecord> {
    const rows = await this.readCycles();
    const cycle = rows.find((c) => c.id === id);
    if (!cycle) throw new CycleError(`Unknown cycle: ${id}`);

    // Validate the dates as they will be after the patch, so moving one end
    // cannot produce a cycle that ends before it starts.
    const startDate = patch.startDate ?? cycle.startDate;
    const endDate = patch.endDate ?? cycle.endDate;
    const dateError = validateCycleDates(startDate, endDate);
    if (dateError) throw new CycleError(dateError);

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new CycleError("Cycle name is required.");
      cycle.name = name;
    }
    if (patch.productId !== undefined) cycle.productId = patch.productId;
    if (patch.startDate !== undefined) cycle.startDate = patch.startDate;
    if (patch.endDate !== undefined) cycle.endDate = patch.endDate;
    if (patch.notes !== undefined) cycle.notes = patch.notes;

    if (
      rows.some(
        (c) =>
          c.id !== id &&
          c.name === cycle.name &&
          (c.productId ?? null) === (cycle.productId ?? null),
      )
    ) {
      throw new CycleError(`A cycle named "${cycle.name}" already exists.`);
    }
    await this.writeCycles(rows);
    const listed = await this.listCycles();
    return listed.find((c) => c.id === id)!;
  }

  async deleteCycle(id: string, _scope?: WorkspaceScope): Promise<void> {
    const rows = await this.readCycles();
    if (!rows.some((c) => c.id === id))
      throw new CycleError(`Unknown cycle: ${id}`);
    await this.writeCycles(rows.filter((c) => c.id !== id));
    // Unschedule the deleted cycle's items (mirrors the DB's SET NULL).
    await this.retargetCycle((current) => current === id, null);
  }

  async rolloverCycle(
    fromId: string,
    toId: string,
    _scope?: WorkspaceScope,
  ): Promise<CycleRolloverResult> {
    if (fromId === toId) {
      throw new CycleError("Pick a different cycle to roll work into.");
    }
    const rows = await this.readCycles();
    if (!rows.some((c) => c.id === fromId))
      throw new CycleError(`Unknown cycle: ${fromId}`);
    if (!rows.some((c) => c.id === toId))
      throw new CycleError(`Unknown cycle: ${toId}`);
    // Done and archived work stays in the cycle that delivered (or dropped) it.
    const finished = new Set(
      (await this.loadAll())
        .filter((f) => f.status === "done" || f.status === "archived")
        .map((f) => f.specId),
    );
    const moved = await this.retargetCycle(
      (current) => current === fromId,
      toId,
      finished,
    );
    return { moved, toCycleId: toId };
  }

  // ── Goals ─────────────────────────────────────────────────────────────
  // Persisted to `.specboards/local-goals.json` (goals with their key results
  // and links nested, since file mode has no joins to do). File mode has no
  // product roles, so the per-product write checks the DB store makes are
  // absent; every other rule is the same, including the two progress figures
  // being computed on read rather than stored.

  private get goalsPath() {
    return path.join(this.root, ".specboards", "local-goals.json");
  }

  private async readGoals(): Promise<LocalGoal[]> {
    return this.readJsonFile<LocalGoal>(this.goalsPath);
  }

  private async writeGoals(rows: LocalGoal[]): Promise<void> {
    await fs.mkdir(path.dirname(this.goalsPath), { recursive: true });
    await fs.writeFile(
      this.goalsPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  /** Build the UI record for one stored goal, computing both progress figures. */
  private toGoalRecord(
    goal: LocalGoal,
    doneBySpecId: Map<string, boolean>,
  ): GoalRecord {
    const measures = (goal.keyResults ?? [])
      .slice()
      .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    // Links to items that no longer exist are ignored rather than counted as
    // not-done, which would drag delivery progress down for no reason.
    const links = (goal.linkedSpecIds ?? [])
      .filter((specId) => doneBySpecId.has(specId))
      .map((specId) => ({ done: doneBySpecId.get(specId) === true }));
    return {
      id: goal.id,
      title: goal.title,
      description: goal.description ?? null,
      productId: goal.productId ?? null,
      periodStart: goal.periodStart ?? null,
      periodEnd: goal.periodEnd ?? null,
      parentGoalId: goal.parentGoalId ?? null,
      status: goal.status,
      keyResults: measures.map((kr) => ({
        ...kr,
        goalId: goal.id,
        progress: keyResultProgress(kr),
      })),
      progress: goalProgress(measures),
      linkedItemCount: links.length,
      deliveryProgress: deliveryProgress(links),
    };
  }

  /** Map of specId -> is the item done, over every item in the workspace. */
  private async doneBySpecId(): Promise<Map<string, boolean>> {
    return new Map(
      (await this.loadAll()).map((f) => [f.specId, isDone(f.status)]),
    );
  }

  // ==========================================================================
  // Goals and key results
  // ==========================================================================

  async listGoals(_scope?: WorkspaceScope): Promise<GoalRecord[]> {
    const [rows, doneMap] = await Promise.all([
      this.readGoals(),
      this.doneBySpecId(),
    ]);
    return rows.map((g) => this.toGoalRecord(g, doneMap)).sort(compareGoals);
  }

  async createGoal(
    input: GoalInput,
    _scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    const title = input.title.trim();
    if (!title) throw new GoalError("Goal title is required.");
    const periodError = validateGoalPeriod(
      input.periodStart ?? null,
      input.periodEnd ?? null,
    );
    if (periodError) throw new GoalError(periodError);
    const status = input.status ?? "on_track";
    if (!isGoalStatus(status)) {
      throw new GoalError(`Unknown goal status: ${status}`);
    }
    const rows = await this.readGoals();
    if (input.parentGoalId && !rows.some((g) => g.id === input.parentGoalId)) {
      throw new GoalError(`Unknown goal: ${input.parentGoalId}`);
    }
    const goal: LocalGoal = {
      id: randomUUID(),
      title,
      description: input.description ?? null,
      productId: input.productId ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      parentGoalId: input.parentGoalId ?? null,
      status,
      keyResults: [],
      linkedSpecIds: [],
    };
    await this.writeGoals([...rows, goal]);
    return this.toGoalRecord(goal, new Map());
  }

  async updateGoal(
    id: string,
    patch: GoalPatch,
    _scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    const rows = await this.readGoals();
    const goal = rows.find((g) => g.id === id);
    if (!goal) throw new GoalError(`Unknown goal: ${id}`);

    const periodStart =
      patch.periodStart !== undefined ? patch.periodStart : goal.periodStart ?? null;
    const periodEnd =
      patch.periodEnd !== undefined ? patch.periodEnd : goal.periodEnd ?? null;
    const periodError = validateGoalPeriod(periodStart, periodEnd);
    if (periodError) throw new GoalError(periodError);

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new GoalError("Goal title is required.");
      goal.title = title;
    }
    if (patch.description !== undefined) goal.description = patch.description;
    if (patch.productId !== undefined) goal.productId = patch.productId;
    if (patch.periodStart !== undefined) goal.periodStart = patch.periodStart;
    if (patch.periodEnd !== undefined) goal.periodEnd = patch.periodEnd;
    if (patch.status !== undefined) {
      if (!isGoalStatus(patch.status)) {
        throw new GoalError(`Unknown goal status: ${patch.status}`);
      }
      goal.status = patch.status;
    }
    if (patch.parentGoalId !== undefined) {
      if (patch.parentGoalId !== null) {
        if (!rows.some((g) => g.id === patch.parentGoalId)) {
          throw new GoalError(`Unknown goal: ${patch.parentGoalId}`);
        }
        const tree = rows.map((g) => ({
          id: g.id,
          parentGoalId: g.parentGoalId ?? null,
        }));
        if (wouldCreateGoalCycle(tree, id, patch.parentGoalId)) {
          throw new GoalError("A goal cannot be nested under itself.");
        }
      }
      goal.parentGoalId = patch.parentGoalId;
    }
    await this.writeGoals(rows);
    return this.toGoalRecord(goal, await this.doneBySpecId());
  }

  async deleteGoal(id: string, _scope?: WorkspaceScope): Promise<void> {
    const rows = await this.readGoals();
    if (!rows.some((g) => g.id === id)) {
      throw new GoalError(`Unknown goal: ${id}`);
    }
    // Children are orphaned to the root, not deleted with their parent
    // (mirrors the DB's ON DELETE SET NULL on parent_goal_id).
    for (const goal of rows) {
      if (goal.parentGoalId === id) goal.parentGoalId = null;
    }
    await this.writeGoals(rows.filter((g) => g.id !== id));
  }

  /** Resolve a goal by id from the stored set, or throw. */
  private async goalById(
    rows: LocalGoal[],
    id: string,
  ): Promise<LocalGoal> {
    const goal = rows.find((g) => g.id === id);
    if (!goal) throw new GoalError(`Unknown goal: ${id}`);
    return goal;
  }

  async createKeyResult(
    goalId: string,
    input: KeyResultInput,
    _scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    const rows = await this.readGoals();
    const goal = await this.goalById(rows, goalId);
    const title = input.title.trim();
    if (!title) throw new GoalError("Key result title is required.");
    const metricKind = input.metricKind ?? "number";
    const startValue = input.startValue ?? 0;
    const error = validateKeyResult({
      metricKind,
      startValue,
      targetValue: input.targetValue,
    });
    if (error) throw new GoalError(error);
    goal.keyResults = goal.keyResults ?? [];
    goal.keyResults.push({
      id: randomUUID(),
      title,
      metricKind,
      startValue,
      targetValue: input.targetValue,
      currentValue: input.currentValue ?? startValue,
      position: goal.keyResults.length,
    });
    await this.writeGoals(rows);
    return this.toGoalRecord(goal, await this.doneBySpecId());
  }

  async updateKeyResult(
    id: string,
    patch: KeyResultPatch,
    _scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    const rows = await this.readGoals();
    const goal = rows.find((g) => (g.keyResults ?? []).some((k) => k.id === id));
    if (!goal) throw new GoalError(`Unknown key result: ${id}`);
    const kr = goal.keyResults!.find((k) => k.id === id)!;

    const metricKind = patch.metricKind ?? kr.metricKind;
    const startValue = patch.startValue ?? kr.startValue;
    const targetValue = patch.targetValue ?? kr.targetValue;
    const error = validateKeyResult({ metricKind, startValue, targetValue });
    if (error) throw new GoalError(error);

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new GoalError("Key result title is required.");
      kr.title = title;
    }
    if (patch.metricKind !== undefined) kr.metricKind = patch.metricKind;
    if (patch.startValue !== undefined) kr.startValue = patch.startValue;
    if (patch.targetValue !== undefined) kr.targetValue = patch.targetValue;
    if (patch.currentValue !== undefined) kr.currentValue = patch.currentValue;
    if (patch.position !== undefined) kr.position = patch.position;
    await this.writeGoals(rows);
    return this.toGoalRecord(goal, await this.doneBySpecId());
  }

  async deleteKeyResult(
    id: string,
    _scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    const rows = await this.readGoals();
    const goal = rows.find((g) => (g.keyResults ?? []).some((k) => k.id === id));
    if (!goal) throw new GoalError(`Unknown key result: ${id}`);
    goal.keyResults = goal.keyResults!.filter((k) => k.id !== id);
    await this.writeGoals(rows);
    return this.toGoalRecord(goal, await this.doneBySpecId());
  }

  async listGoalContributions(
    goalId: string,
    _scope?: WorkspaceScope,
  ): Promise<GoalContribution[]> {
    const [rows, all] = await Promise.all([this.readGoals(), this.loadAll()]);
    const goal = await this.goalById(rows, goalId);
    const linked = new Set(goal.linkedSpecIds ?? []);
    return all
      .filter((f) => linked.has(f.specId))
      .map((f) => ({
        specId: f.specId,
        title: f.title,
        status: f.status,
        level: f.level,
        productId: f.productId,
        done: isDone(f.status),
      }));
  }

  async listGoalLinks(_scope?: WorkspaceScope): Promise<GoalLinkRef[]> {
    const [rows, all] = await Promise.all([this.readGoals(), this.loadAll()]);
    // Links to items that no longer exist are dropped, matching how the two
    // progress figures already ignore them.
    const known = new Set(all.map((f) => f.specId));
    return rows.flatMap((goal) =>
      (goal.linkedSpecIds ?? [])
        .filter((specId) => known.has(specId))
        .map((specId) => ({ goalId: goal.id, specId })),
    );
  }

  async listItemGoals(
    specId: string,
    _scope?: WorkspaceScope,
  ): Promise<ItemGoalRef[]> {
    const rows = await this.readGoals();
    return rows
      .filter((g) => (g.linkedSpecIds ?? []).includes(specId))
      .map((g) => ({
        goalId: g.id,
        title: g.title,
        status: g.status,
        productId: g.productId ?? null,
      }));
  }

  async linkGoal(
    goalId: string,
    specId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    const rows = await this.readGoals();
    const goal = await this.goalById(rows, goalId);
    const all = await this.loadAll();
    if (!all.some((f) => f.specId === specId)) {
      throw new GoalError(`Unknown work item: ${specId}`);
    }
    goal.linkedSpecIds = goal.linkedSpecIds ?? [];
    // Linking twice is a no-op: the caller's intent is already true.
    if (!goal.linkedSpecIds.includes(specId)) goal.linkedSpecIds.push(specId);
    await this.writeGoals(rows);
  }

  async unlinkGoal(
    goalId: string,
    specId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    const rows = await this.readGoals();
    const goal = await this.goalById(rows, goalId);
    goal.linkedSpecIds = (goal.linkedSpecIds ?? []).filter((s) => s !== specId);
    await this.writeGoals(rows);
  }

  // ── Comments ──────────────────────────────────────────────────────────
  // Persisted to `.specboards/local-comments.json`. File mode has no user
  // records, so every comment is authored by LOCAL_USER with a null name.

  private async readComments(): Promise<LocalComment[]> {
    return this.readJsonFile<LocalComment>(this.commentsPath);
  }

  private async assertItemExists(specId: string): Promise<void> {
    const all = await this.loadAll();
    if (!all.some((f) => f.specId === specId)) {
      throw new CommentError(`Unknown item: ${specId}`);
    }
  }

  // ==========================================================================
  // Comments
  // ==========================================================================

  async listComments(
    specId: string,
    _scope?: WorkspaceScope,
  ): Promise<CommentRecord[]> {
    await this.assertItemExists(specId);
    const rows = await this.readComments();
    return rows
      .filter((c) => c.specId === specId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => ({
        id: c.id,
        featureId: c.specId,
        authorId: c.authorId,
        authorName: null,
        authorImage: null,
        body: c.body,
        createdAt: c.createdAt,
      }));
  }

  async createComment(
    specId: string,
    input: CommentInput,
    _scope?: WorkspaceScope,
  ): Promise<CommentRecord> {
    const body = input.body.trim();
    if (!body) throw new CommentError("Comment body is required.");
    await this.assertItemExists(specId);
    const rows = await this.readComments();
    const comment: LocalComment = {
      id: randomUUID(),
      specId,
      authorId: LOCAL_USER,
      body,
      createdAt: new Date().toISOString(),
    };
    await this.writeJsonFile(this.commentsPath, [...rows, comment]);
    return {
      id: comment.id,
      featureId: specId,
      authorId: comment.authorId,
      authorName: null,
      authorImage: null,
      body: comment.body,
      createdAt: comment.createdAt,
    };
  }

  async deleteComment(
    commentId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    const rows = await this.readComments();
    if (!rows.some((c) => c.id === commentId)) {
      throw new CommentError(`Unknown comment: ${commentId}`);
    }
    await this.writeJsonFile(
      this.commentsPath,
      rows.filter((c) => c.id !== commentId),
    );
  }

  // ==========================================================================
  // Notifications
  // ==========================================================================

  // Notifications are a multi-user, @mention-driven concept; local file mode is
  // a single user with no members to mention, so the inbox is always empty.
  async listNotifications(_scope?: WorkspaceScope): Promise<NotificationList> {
    return { items: [], unreadCount: 0 };
  }

  async markNotificationRead(
    _id: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {}

  async markAllNotificationsRead(_scope?: WorkspaceScope): Promise<void> {}

  // ==========================================================================
  // Products, product groups, members, and roll-up summaries
  //
  // `deleteProduct` is out of place: it sits after `getWorkspaceSummary` at the
  // end of this block rather than with the other product mutations.
  // ==========================================================================

  // Products. Local file mode is a single all-powerful user (see core
  // LOCAL_PRODUCT_ACCESS), so visibility/permissions aren't enforced; products
  // persist to `.specboards/local-products.json` for switcher parity.
  async getProductAccess(_scope?: WorkspaceScope): Promise<ProductAccess> {
    return LOCAL_PRODUCT_ACCESS;
  }

  /** Item counts per product, derived from all features (specs + items). */
  private async productItemCounts(): Promise<Map<string, number>> {
    const features = await this.loadAll();
    const out = new Map<string, number>();
    for (const f of features) {
      if (f.productId) out.set(f.productId, (out.get(f.productId) ?? 0) + 1);
    }
    return out;
  }

  private toProductRecord(
    p: LocalProduct,
    counts: Map<string, number>,
  ): ProductRecord {
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      description: p.description,
      visibility: p.visibility,
      position: p.position,
      color: p.color ?? null,
      groupId: p.groupId ?? null,
      itemCount: counts.get(p.id) ?? 0,
      viewerRole: null,
    };
  }

  async listProducts(_scope?: WorkspaceScope): Promise<ProductRecord[]> {
    const [products, counts] = await Promise.all([
      this.readProducts(),
      this.productItemCounts(),
    ]);
    return products
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((p) => this.toProductRecord(p, counts));
  }

  async getProduct(
    key: string,
    _scope?: WorkspaceScope,
  ): Promise<ProductRecord | null> {
    const products = await this.readProducts();
    const p = products.find((x) => x.key === key);
    if (!p) return null;
    return this.toProductRecord(p, await this.productItemCounts());
  }

  async createProduct(
    input: CreateProductInput,
    _scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    const name = input.name.trim();
    if (!name) throw new ProductError("Product name is required.");
    const products = await this.readProducts();
    const key = productKeyFromName(name, new Set(products.map((p) => p.key)));
    const product: LocalProduct = {
      id: randomUUID(),
      key,
      name,
      description: input.description ?? null,
      visibility: input.visibility ?? "org",
      color: input.color ?? null,
      position: products.reduce((m, p) => Math.max(m, p.position), -1) + 1,
    };
    await this.writeProducts([...products, product]);
    return this.toProductRecord(product, new Map());
  }

  async updateProduct(
    id: string,
    patch: ProductPatch,
    _scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    const products = await this.readProducts();
    const p = products.find((x) => x.id === id);
    if (!p) throw new ProductError(`Unknown product: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ProductError("Product name is required.");
      p.name = name;
    }
    if (patch.description !== undefined) p.description = patch.description;
    if (patch.visibility !== undefined) p.visibility = patch.visibility;
    if (patch.position !== undefined) p.position = patch.position;
    if (patch.color !== undefined) p.color = patch.color;
    if (patch.groupId !== undefined) {
      if (patch.groupId !== null) {
        const groups = await this.readGroups();
        if (!groups.some((g) => g.id === patch.groupId)) {
          throw new GroupError(`Unknown product group: ${patch.groupId}`);
        }
      }
      p.groupId = patch.groupId;
    }
    await this.writeProducts(products);
    return this.toProductRecord(p, await this.productItemCounts());
  }

  async listProductGroups(
    _scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord[]> {
    const [groups, products] = await Promise.all([
      this.readGroups(),
      this.readProducts(),
    ]);
    return groups
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((g) => ({
        ...g,
        productCount: products.filter((p) => p.groupId === g.id).length,
      }));
  }

  async createProductGroup(
    input: CreateProductGroupInput,
    _scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord> {
    const name = input.name.trim();
    if (!name) throw new GroupError("Group name is required.");
    const groups = await this.readGroups();
    const parentId = input.parentId ?? null;
    if (parentId) {
      if (!groups.some((g) => g.id === parentId)) {
        throw new GroupError(`Unknown product group: ${parentId}`);
      }
      if (wouldExceedDepth(groups, "new-group", parentId)) {
        throw new GroupError("Groups can only be nested a few levels deep.");
      }
    }
    const group: LocalProductGroup = {
      id: randomUUID(),
      key: groupKeyFromName(name, new Set(groups.map((g) => g.key))),
      name,
      description: input.description ?? null,
      color: input.color ?? null,
      parentId,
      position: groups.reduce((m, g) => Math.max(m, g.position), -1) + 1,
    };
    await this.writeGroups([...groups, group]);
    return { ...group, productCount: 0 };
  }

  async updateProductGroup(
    id: string,
    patch: ProductGroupPatch,
    _scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord> {
    const groups = await this.readGroups();
    const g = groups.find((x) => x.id === id);
    if (!g) throw new GroupError(`Unknown product group: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new GroupError("Group name is required.");
      g.name = name;
    }
    if (patch.description !== undefined) g.description = patch.description;
    if (patch.color !== undefined) g.color = patch.color;
    if (patch.position !== undefined) g.position = patch.position;
    if (patch.parentId !== undefined) {
      if (patch.parentId !== null) {
        if (!groups.some((x) => x.id === patch.parentId)) {
          throw new GroupError(`Unknown product group: ${patch.parentId}`);
        }
        if (wouldCreateCycle(groups, id, patch.parentId)) {
          throw new GroupError(
            "A group can't be nested inside itself or its own subgroups.",
          );
        }
        if (wouldExceedDepth(groups, id, patch.parentId)) {
          throw new GroupError("Groups can only be nested a few levels deep.");
        }
      }
      g.parentId = patch.parentId;
    }
    await this.writeGroups(groups);
    const products = await this.readProducts();
    return {
      ...g,
      productCount: products.filter((p) => p.groupId === g.id).length,
    };
  }

  async deleteProductGroup(id: string, _scope?: WorkspaceScope): Promise<void> {
    const groups = await this.readGroups();
    if (!groups.some((g) => g.id === id)) {
      throw new GroupError(`Unknown product group: ${id}`);
    }
    if (groups.some((g) => g.parentId === id)) {
      throw new GroupError("Can't delete a group while it still has subgroups.");
    }
    const products = await this.readProducts();
    if (products.some((p) => p.groupId === id)) {
      throw new GroupError("Can't delete a group while it still has products.");
    }
    await this.writeGroups(groups.filter((g) => g.id !== id));
  }

  async getGroupSummary(
    id: string,
    _scope?: WorkspaceScope,
  ): Promise<GroupSummary> {
    const [groups, products, allFeatures] = await Promise.all([
      this.readGroups(),
      this.readProducts(),
      this.loadAll(),
    ]);
    const group = groups.find((g) => g.id === id);
    if (!group) throw new GroupError(`Unknown product group: ${id}`);

    const subtree = descendantGroupIds(groups, id);
    const member = products.filter((p) => p.groupId && subtree.has(p.groupId));
    const summaries = new Map<string, GroupProductSummary>(
      member.map((p) => [
        p.id,
        { productId: p.id, itemCount: 0, statusCounts: {}, releases: [] },
      ]),
    );
    const releaseTotals = new Map<string, Map<string, { total: number; done: number }>>();
    for (const f of allFeatures) {
      if (!f.productId) continue;
      const summary = summaries.get(f.productId);
      if (!summary) continue;
      summary.itemCount += 1;
      summary.statusCounts[f.status] = (summary.statusCounts[f.status] ?? 0) + 1;
      if (f.releaseId) {
        const byRelease =
          releaseTotals.get(f.productId) ??
          new Map<string, { total: number; done: number }>();
        releaseTotals.set(f.productId, byRelease);
        const entry = byRelease.get(f.releaseId) ?? { total: 0, done: 0 };
        entry.total += 1;
        if (f.status === "done") entry.done += 1;
        byRelease.set(f.releaseId, entry);
      }
    }
    for (const [productId, byRelease] of releaseTotals) {
      const summary = summaries.get(productId);
      if (!summary) continue;
      summary.releases = [...byRelease.entries()].map(
        ([releaseId, { total, done }]) => ({ releaseId, total, done }),
      );
    }

    const productCount = (gid: string) =>
      products.filter((p) => p.groupId === gid).length;
    return {
      group: { ...group, productCount: productCount(group.id) },
      subgroups: groups
        .filter((g) => g.parentId === id)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((g) => ({ ...g, productCount: productCount(g.id) })),
      products: [...member]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((p) => summaries.get(p.id)!),
    };
  }

  async listBlockingEdges(_scope?: WorkspaceScope): Promise<BlockingEdge[]> {
    const [meta, features] = await Promise.all([
      this.readMetadata(),
      this.loadAll(),
    ]);
    const known = new Set(features.map((f) => f.specId));
    const out: BlockingEdge[] = [];
    for (const [fromSpec, m] of Object.entries(meta)) {
      for (const link of m.links ?? []) {
        // Same rule as the relation counts: both ends must resolve to a real
        // item, so a link to a deleted spec is not drawn.
        if (link.type !== "blocks") continue;
        if (!known.has(fromSpec) || !known.has(link.to)) continue;
        out.push({ blockerSpecId: fromSpec, blockedSpecId: link.to });
      }
    }
    return out;
  }

  async getWorkspaceSummary(
    options: WorkspaceSummaryOptions,
    _scope?: WorkspaceScope,
  ): Promise<WorkspaceSummary> {
    const [products, allFeatures, releases] = await Promise.all([
      this.readProducts(),
      this.loadAll(),
      this.listReleases(),
    ]);

    // Same aggregation as getGroupSummary, over every product rather than one
    // subtree. File mode is single-user, so everything is readable.
    const summaries = new Map<string, GroupProductSummary>(
      products.map((p) => [
        p.id,
        { productId: p.id, itemCount: 0, statusCounts: {}, releases: [] },
      ]),
    );
    const releaseTotals = new Map<
      string,
      Map<string, { total: number; done: number }>
    >();
    for (const f of allFeatures) {
      if (!f.productId) continue;
      const summary = summaries.get(f.productId);
      if (!summary) continue;
      summary.itemCount += 1;
      summary.statusCounts[f.status] = (summary.statusCounts[f.status] ?? 0) + 1;
      if (f.releaseId) {
        const byRelease =
          releaseTotals.get(f.productId) ??
          new Map<string, { total: number; done: number }>();
        releaseTotals.set(f.productId, byRelease);
        const entry = byRelease.get(f.releaseId) ?? { total: 0, done: 0 };
        entry.total += 1;
        if (isDone(f.status)) entry.done += 1;
        byRelease.set(f.releaseId, entry);
      }
    }
    for (const [productId, byRelease] of releaseTotals) {
      const summary = summaries.get(productId);
      if (!summary) continue;
      summary.releases = [...byRelease.entries()].map(
        ([releaseId, { total, done }]) => ({ releaseId, total, done }),
      );
    }

    const live = allFeatures.filter(
      (f) => f.status !== "archived" && !isDone(f.status),
    );
    const signal = (f: (typeof live)[number]): SignalItem => ({
      specId: f.specId,
      title: f.title,
      level: f.level,
      status: f.status,
      productId: f.productId,
      releaseId: f.releaseId,
    });
    const overdueReleases = new Set(
      releases
        .filter(
          (r) =>
            r.status !== "shipped" &&
            r.targetDate !== null &&
            r.targetDate < options.today,
        )
        .map((r) => r.id),
    );
    const blocked = live.filter((f) => f.blockedByCount > 0).map(signal);
    const overdue = live
      .filter((f) => f.releaseId && overdueReleases.has(f.releaseId))
      .map(signal);
    // File mode keeps no per-item updated_at, so staleness is unknowable here.
    // Reporting an empty list is honest; inventing one from file mtimes would
    // measure when the repo was cloned, not when the work last moved.
    return {
      products: [...products]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((p) => summaries.get(p.id)!),
      signals: {
        blocked: blocked.slice(0, SIGNAL_SAMPLE_LIMIT),
        overdue: overdue.slice(0, SIGNAL_SAMPLE_LIMIT),
        stale: [],
        counts: {
          blocked: blocked.length,
          overdue: overdue.length,
          stale: 0,
        },
      },
    };
  }

  async deleteProduct(id: string, _scope?: WorkspaceScope): Promise<void> {
    const counts = await this.productItemCounts();
    if ((counts.get(id) ?? 0) > 0) {
      throw new ProductError(
        "Can't delete a product while it still has work items.",
      );
    }
    const products = await this.readProducts();
    if (!products.some((p) => p.id === id))
      throw new ProductError(`Unknown product: ${id}`);
    await this.writeProducts(products.filter((p) => p.id !== id));
  }

  // Membership needs real user records, which file mode doesn't have.
  async listProductMembers(
    _productId: string,
    _scope?: WorkspaceScope,
  ): Promise<ProductMemberRecord[]> {
    return [];
  }

  async setProductMember(
    _productId: string,
    _input: ProductMemberInput,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    throw new ProductError(
      "Managing product members requires authentication (not available in local file mode).",
    );
  }

  async removeProductMember(
    _productId: string,
    _userId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    // Nothing to remove in file mode.
  }

  // Ideas persist to `.specboards/local-ideas.json` (+ statuses/settings files).
  private async readIdeas(): Promise<LocalIdea[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.ideasPath, "utf8"),
      ) as LocalIdea[];
    } catch {
      return [];
    }
  }

  private async writeIdeas(rows: LocalIdea[]): Promise<void> {
    await fs.mkdir(path.dirname(this.ideasPath), { recursive: true });
    await fs.writeFile(
      this.ideasPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  private toIdeaRecord(
    row: LocalIdea,
    promotedTitle: string | null,
  ): IdeaRecord {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      productId: row.productId,
      authorName: null,
      submitterName: row.submitterName,
      voteCount: row.voters.length,
      viewerHasVoted: row.voters.includes(LOCAL_USER),
      promotedFeatureSpecId: row.promotedFeatureSpecId,
      promotedFeatureTitle: promotedTitle,
      createdAt: row.createdAt,
    };
  }

  // ==========================================================================
  // Ideas
  // ==========================================================================

  async listIdeas(_scope?: WorkspaceScope): Promise<IdeaRecord[]> {
    const [rows, all] = await Promise.all([this.readIdeas(), this.loadAll()]);
    const titleBySpec = new Map(all.map((f) => [f.specId, f.title] as const));
    return rows
      .map((r) =>
        this.toIdeaRecord(
          r,
          r.promotedFeatureSpecId
            ? (titleBySpec.get(r.promotedFeatureSpecId) ?? null)
            : null,
        ),
      )
      .sort(
        (a, b) =>
          b.voteCount - a.voteCount ||
          (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
      );
  }

  async createIdea(
    input: IdeaInput,
    _scope?: WorkspaceScope,
  ): Promise<IdeaRecord> {
    const title = input.title.trim();
    if (!title) throw new IdeaError("Idea title is required.");
    const productId = input.productId ?? (await this.defaultProductId());
    const idea: LocalIdea = {
      id: randomUUID(),
      title,
      description: input.description?.trim() ? input.description.trim() : null,
      status: "new",
      productId,
      submitterName: null,
      promotedFeatureSpecId: null,
      voters: [],
      createdAt: new Date().toISOString(),
    };
    const rows = await this.readIdeas();
    await this.writeIdeas([...rows, idea]);
    return this.toIdeaRecord(idea, null);
  }

  async updateIdea(
    id: string,
    patch: IdeaPatch,
    _scope?: WorkspaceScope,
  ): Promise<IdeaRecord> {
    const rows = await this.readIdeas();
    const idea = rows.find((r) => r.id === id);
    if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new IdeaError("Idea title is required.");
      idea.title = title;
    }
    if (patch.description !== undefined) {
      idea.description = patch.description?.trim()
        ? patch.description.trim()
        : null;
    }
    if (patch.status !== undefined) {
      const stages = resolveIdeaStages(await this.readIdeaStages());
      if (!stages.some((s) => s.key === patch.status)) {
        throw new IdeaError(`Unknown idea status: ${patch.status}`);
      }
      idea.status = patch.status;
    }
    if (patch.productId !== undefined) {
      idea.productId = patch.productId ?? (await this.defaultProductId());
    }
    await this.writeIdeas(rows);
    const title = idea.promotedFeatureSpecId
      ? ((await this.loadAll()).find(
          (f) => f.specId === idea.promotedFeatureSpecId,
        )?.title ?? null)
      : null;
    return this.toIdeaRecord(idea, title);
  }

  async deleteIdea(id: string, _scope?: WorkspaceScope): Promise<void> {
    const rows = await this.readIdeas();
    if (!rows.some((r) => r.id === id))
      throw new IdeaError(`Unknown idea: ${id}`);
    await this.writeIdeas(rows.filter((r) => r.id !== id));
  }

  async voteIdea(id: string, _scope?: WorkspaceScope): Promise<IdeaRecord> {
    const rows = await this.readIdeas();
    const idea = rows.find((r) => r.id === id);
    if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
    if (!idea.voters.includes(LOCAL_USER)) idea.voters.push(LOCAL_USER);
    await this.writeIdeas(rows);
    return this.toIdeaRecord(idea, null);
  }

  async unvoteIdea(id: string, _scope?: WorkspaceScope): Promise<IdeaRecord> {
    const rows = await this.readIdeas();
    const idea = rows.find((r) => r.id === id);
    if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
    idea.voters = idea.voters.filter((v) => v !== LOCAL_USER);
    await this.writeIdeas(rows);
    return this.toIdeaRecord(idea, null);
  }

  async promoteIdea(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
    const rows = await this.readIdeas();
    const idea = rows.find((r) => r.id === id);
    if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
    if (idea.promotedFeatureSpecId) {
      throw new IdeaError("This idea has already been promoted.");
    }
    const levels = resolveLevels();
    const target = [...levels].reverse().find((l) => !l.isLeaf);
    if (!target) {
      throw new IdeaError(
        "This workspace has no non-leaf level to promote an idea into.",
      );
    }
    const feature = await this.createFeature(
      {
        title: idea.title,
        level: target.key,
        productId: idea.productId,
        details: idea.description,
      },
      scope,
    );
    const stages = resolveIdeaStages(await this.readIdeaStages());
    idea.promotedFeatureSpecId = feature.specId;
    idea.status = promotedIdeaStatus(idea.status, stages);
    await this.writeIdeas(rows);
    return { idea: this.toIdeaRecord(idea, feature.title), feature };
  }

  private async readIdeaStages(): Promise<IdeaStage[]> {
    try {
      const rows = JSON.parse(
        await fs.readFile(this.ideaStatusesPath, "utf8"),
      ) as IdeaStage[];
      return rows
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((r, i) => ({ ...r, position: i }));
    } catch {
      return [];
    }
  }

  async listIdeaStatuses(_scope?: WorkspaceScope): Promise<IdeaStage[]> {
    return this.readIdeaStages();
  }

  async replaceIdeaStatuses(
    stages: StatusStageInput[],
    _scope?: WorkspaceScope,
  ): Promise<IdeaStage[]> {
    const rows: IdeaStage[] = stages.map((s, i) => ({
      key: s.key,
      label: s.label,
      position: i,
    }));
    const validKeys = new Set(rows.map((r) => r.key));
    const fallback = rows[0]?.key;
    // Re-home orphaned ideas onto the first stage, mirroring the DB store.
    if (fallback) {
      const ideas = await this.readIdeas();
      let changed = false;
      for (const idea of ideas) {
        if (!validKeys.has(idea.status)) {
          idea.status = fallback;
          changed = true;
        }
      }
      if (changed) await this.writeIdeas(ideas);
    }
    await fs.mkdir(path.dirname(this.ideaStatusesPath), { recursive: true });
    await fs.writeFile(
      this.ideaStatusesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
    return rows;
  }

  // ==========================================================================
  // Transition mode, property unions, and card configuration
  // ==========================================================================

  /**
   * Local file mode has no workspace row to hold the setting, and a solo
   * dogfooding session is the case that least wants a rigid pipeline, so it is
   * always flexible. Teams that want a strict pipeline are running the DB mode.
   */
  async getTransitionMode(
    _scope?: WorkspaceScope,
    _productId?: string | null,
  ): Promise<TransitionMode> {
    return "flexible";
  }

  /** Nothing to override, for the same reason the mode is fixed above. */
  /** One product by construction, so every union is just the list itself. */
  async listPropertiesUnion(
    scope: WorkspaceScope | undefined,
    _productIds: string[] | null,
    entity?: PropertyEntity,
  ): Promise<PropertyDef[]> {
    return this.listProperties(scope, entity);
  }

  /**
   * Local file mode has one product by construction, so a cross-product board
   * is the same board and the union is just the stage list.
   */
  async listStatusesUnion(
    scope: WorkspaceScope | undefined,
    _productIds: string[] | null,
  ): Promise<WorkspaceStatus[]> {
    return this.listStatuses(scope);
  }

  /** One product, nothing to inherit from: nothing is ever an override. */
  async cardsOverrides(): Promise<CardsOverrides> {
    return {
      transitionMode: false,
      stages: false,
      stageGates: false,
      properties: false,
      detailTemplates: false,
      cardFields: false,
      levelTemplates: false,
    };
  }

  async listTransitionModes(
    _scope?: WorkspaceScope,
  ): Promise<TransitionModeSettings> {
    return { workspaceDefault: "flexible", overrides: {} };
  }

  async setTransitionMode(
    mode: TransitionMode | null,
    _scope?: WorkspaceScope,
    _productId?: string | null,
  ): Promise<TransitionMode> {
    if (mode !== "flexible") {
      throw new Error(
        "Local file mode is always flexible; set transitions per workspace in the hosted app.",
      );
    }
    return mode;
  }

  // ==========================================================================
  // Idea settings
  // ==========================================================================

  async getIdeaSettings(_scope?: WorkspaceScope): Promise<IdeaSettings> {
    try {
      const row = JSON.parse(
        await fs.readFile(this.ideaSettingsPath, "utf8"),
      ) as LocalIdeaSettings;
      return {
        portalEnabled: row.portalEnabled ?? false,
        portalTitle: row.portalTitle ?? null,
      };
    } catch {
      return { portalEnabled: false, portalTitle: null };
    }
  }

  async updateIdeaSettings(
    patch: IdeaSettingsPatch,
    _scope?: WorkspaceScope,
  ): Promise<IdeaSettings> {
    const current = await this.getIdeaSettings();
    const next: IdeaSettings = {
      portalEnabled: patch.portalEnabled ?? current.portalEnabled,
      portalTitle:
        patch.portalTitle !== undefined
          ? patch.portalTitle?.trim()
            ? patch.portalTitle.trim()
            : null
          : current.portalTitle,
    };
    await fs.mkdir(path.dirname(this.ideaSettingsPath), { recursive: true });
    await fs.writeFile(
      this.ideaSettingsPath,
      JSON.stringify(next, null, 2) + "\n",
      "utf8",
    );
    return next;
  }

  // ── Docs (Plan-section areas) ───────────────────────────────────────────
  // Doc spaces + pages persist to `.specboards/local-doc-*.json`.

  private get docSpacesPath() {
    return path.join(this.root, ".specboards", "local-doc-spaces.json");
  }

  private get docPagesPath() {
    return path.join(this.root, ".specboards", "local-doc-pages.json");
  }

  private async readJsonFile<T>(file: string): Promise<T[]> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T[];
    } catch {
      return [];
    }
  }

  private async writeJsonFile<T>(file: string, rows: T[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(rows, null, 2) + "\n", "utf8");
  }

  // ==========================================================================
  // Doc spaces and pages
  // ==========================================================================

  async getDocSpace(
    productId: string,
    area: DocArea,
    _scope?: WorkspaceScope,
  ): Promise<DocSpace> {
    const rows = await this.readJsonFile<DocSpace>(this.docSpacesPath);
    return (
      rows.find((r) => r.productId === productId && r.area === area) ?? {
        productId,
        area,
        mode: "unset",
        externalUrl: null,
        repoId: null,
      }
    );
  }

  async setDocSpace(
    productId: string,
    area: DocArea,
    input: DocSpaceInput,
    _scope?: WorkspaceScope,
  ): Promise<DocSpace> {
    const externalUrl =
      input.mode === "external"
        ? validateExternalDocUrl(input.externalUrl)
        : null;
    if (input.mode === "github" && !input.repoId) {
      throw new DocError("Choose a repository.");
    }
    const next: DocSpace = {
      productId,
      area,
      mode: input.mode,
      externalUrl,
      repoId: input.mode === "github" ? (input.repoId ?? null) : null,
    };
    const rows = await this.readJsonFile<DocSpace>(this.docSpacesPath);
    const rest = rows.filter(
      (r) => !(r.productId === productId && r.area === area),
    );
    await this.writeJsonFile(this.docSpacesPath, [...rest, next]);
    return next;
  }

  async listDocPages(
    productId: string,
    area: DocArea,
    _scope?: WorkspaceScope,
  ): Promise<DocPageRecord[]> {
    const rows = await this.readJsonFile<DocPageRecord>(this.docPagesPath);
    return rows
      .filter((r) => r.productId === productId && r.area === area)
      .sort(
        (a, b) => a.position - b.position || a.title.localeCompare(b.title),
      );
  }

  async createDocPage(
    input: DocPageInput,
    _scope?: WorkspaceScope,
  ): Promise<DocPageRecord> {
    const title = input.title.trim();
    if (!title) throw new DocError("A title is required.");
    const rows = await this.readJsonFile<DocPageRecord>(this.docPagesPath);
    const parentId = input.parentId ?? null;
    if (parentId)
      this.assertLocalFolder(rows, parentId, input.productId, input.area);
    const siblings = rows.filter(
      (r) => r.productId === input.productId && r.area === input.area,
    );
    const now = new Date().toISOString();
    const page: DocPageRecord = {
      id: randomUUID(),
      productId: input.productId,
      area: input.area,
      parentId,
      kind: input.kind === "folder" ? "folder" : "page",
      title,
      content: input.content ?? "",
      position: siblings.length,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeJsonFile(this.docPagesPath, [...rows, page]);
    return page;
  }

  async updateDocPage(
    id: string,
    patch: DocPagePatch,
    _scope?: WorkspaceScope,
  ): Promise<DocPageRecord> {
    const rows = await this.readJsonFile<DocPageRecord>(this.docPagesPath);
    const page = rows.find((r) => r.id === id);
    if (!page) throw new DocError(`Unknown page: ${id}`);
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new DocError("A title is required.");
      page.title = title;
    }
    if (patch.content !== undefined) {
      if (page.kind === "folder")
        throw new DocError("Folders have no content.");
      page.content = patch.content;
    }
    if (patch.parentId !== undefined) {
      if (patch.parentId === null) {
        page.parentId = null;
      } else {
        if (patch.parentId === id) {
          throw new DocError("A folder cannot contain itself.");
        }
        this.assertLocalFolder(rows, patch.parentId, page.productId, page.area);
        // Refuse moving a folder under its own descendant (cycle).
        let cursor: string | null = patch.parentId;
        while (cursor) {
          const anc = rows.find((r) => r.id === cursor);
          const next: string | null = anc?.parentId ?? null;
          if (next === id)
            throw new DocError("A folder cannot move inside itself.");
          cursor = next;
        }
        page.parentId = patch.parentId;
      }
    }
    page.updatedAt = new Date().toISOString();
    await this.writeJsonFile(this.docPagesPath, rows);
    return page;
  }

  async deleteDocPage(id: string, _scope?: WorkspaceScope): Promise<void> {
    const rows = await this.readJsonFile<DocPageRecord>(this.docPagesPath);
    if (!rows.some((r) => r.id === id))
      throw new DocError(`Unknown page: ${id}`);
    // Remove the row and everything beneath it (folders cascade).
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) {
        if (r.parentId && doomed.has(r.parentId) && !doomed.has(r.id)) {
          doomed.add(r.id);
          grew = true;
        }
      }
    }
    await this.writeJsonFile(
      this.docPagesPath,
      rows.filter((r) => !doomed.has(r.id)),
    );
  }

  private assertLocalFolder(
    rows: DocPageRecord[],
    folderId: string,
    productId: string,
    area: DocArea,
  ): void {
    const folder = rows.find(
      (r) => r.id === folderId && r.productId === productId && r.area === area,
    );
    if (!folder) throw new DocError("Unknown folder.");
    if (folder.kind !== "folder")
      throw new DocError("Pages cannot contain pages.");
  }
}

/** Options only make sense for select/multiselect; other types store none. */
function localNormalizeOptions(
  type: PropertyDef["type"],
  options: string[] | undefined,
): string[] {
  if (type !== "select" && type !== "multiselect") return [];
  return [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
}

/** Walk upward from cwd to find the repo root (the dir holding `specs/`). */
export async function findRepoRoot(start = process.cwd()): Promise<string> {
  if (process.env.SPECBOARDS_ROOT) return process.env.SPECBOARDS_ROOT;
  let dir = start;
  for (;;) {
    try {
      const stat = await fs.stat(path.join(dir, "specs"));
      if (stat.isDirectory()) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
