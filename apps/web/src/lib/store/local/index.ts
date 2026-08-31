import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_PRODUCT_KEY,
  descendantGroupIds,
  groupKeyFromName,
  isPropertyType,
  isValidParentLevel,
  leafLevel,
  DEFAULT_STATUSES,
  LOCAL_PRODUCT_ACCESS,
  parseRepoConfigYaml,
  parseSpec,
  productKeyFromName,
  wouldCreateCycle,
  wouldExceedDepth,
  promotedIdeaStatus,
  propertyKeyFromLabel,
  resolveIdeaStages,
  resolveLevels,
  resolveLevelUpdate,
  terminalStatus,
  type IdeaStage,
  type PropertyDef,
  type PropertyEntity,
  type WorkspaceLevel,
} from "@specboards/core";

import { riceFields } from "@/lib/feature-helpers";

import { isDone, type LocalStoreContext } from "./context";
import { localPath, specsDir } from "./paths";
import * as itemReadStore from "./items-read";
import * as cycleStore from "./cycles";
import * as goalStore from "./goals";
import * as settingsStore from "./settings";
import * as collabStore from "./collaboration";
import * as docStore from "./docs";
import * as releaseStore from "./releases";
import * as viewStore from "./views";
import {
  LOCAL_USER,
  type LocalItem,
  type LocalLink,
  type LocalLinkType,
  type MetadataFile,
} from "./types";
import {
  DetailTemplateError,
  FeatureError,
  GroupError,
  LevelError,
  ProductError,
  PropertyError,
  RelationError,
  type CommentInput,
  type CommentRecord,
  type NotificationList,
  type BoardKey,
  type BoardPreferences,
  type CreateFeatureInput,
  type CreateProductGroupInput,
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
  type DocArea,
  type DocPageInput,
  type DocPagePatch,
  type DocPageRecord,
  type DocSpace,
  type DocSpaceInput,
  type LevelUpdate,
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
} from "../types";

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
export class LocalFileStore implements FeatureStore, LocalStoreContext {
  /**
   * Not private, because the domain modules in this directory reach for it
   * through `LocalStoreContext`. Still not public: `store/index.ts` hands
   * callers a `FeatureStore`, and that interface does not mention it.
   */
  constructor(readonly root: string) {}

  /** Persisted products, seeded with the default product when none exist. */
  private async readProducts(): Promise<LocalProduct[]> {
    try {
      const rows = JSON.parse(
        await fs.readFile(localPath(this.root, "products"), "utf8"),
      ) as LocalProduct[];
      if (rows.length > 0) return rows;
    } catch {
      /* fall through to the seed */
    }
    return [{ ...LOCAL_DEFAULT_PRODUCT }];
  }

  private async writeProducts(rows: LocalProduct[]): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "products")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "products"),
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  private async readGroups(): Promise<LocalProductGroup[]> {
    try {
      return JSON.parse(
        await fs.readFile(localPath(this.root, "productGroups"), "utf8"),
      ) as LocalProductGroup[];
    } catch {
      return [];
    }
  }

  private async writeGroups(rows: LocalProductGroup[]): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "productGroups")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "productGroups"),
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  /** The default product id (the seeded "default", or the first product). */
  async defaultProductId(): Promise<string> {
    const products = await this.readProducts();
    return (
      products.find((p) => p.key === DEFAULT_PRODUCT_KEY)?.id ??
      products[0]?.id ??
      LOCAL_DEFAULT_PRODUCT.id
    );
  }

  /** The configured hierarchy levels, or null when none are persisted. */
  async readLevels(): Promise<WorkspaceLevel[] | null> {
    try {
      return JSON.parse(
        await fs.readFile(localPath(this.root, "levels"), "utf8"),
      ) as WorkspaceLevel[];
    } catch {
      return null;
    }
  }

  async writeLevels(levels: WorkspaceLevel[]): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "levels")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "levels"),
      JSON.stringify(levels, null, 2) + "\n",
      "utf8",
    );
  }

  /** DB-native work items (initiatives/epics) persisted alongside metadata. */
  async readItems(): Promise<LocalItem[]> {
    try {
      return JSON.parse(
        await fs.readFile(localPath(this.root, "items"), "utf8"),
      ) as LocalItem[];
    } catch {
      return [];
    }
  }

  async writeItems(items: LocalItem[]): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "items")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "items"),
      JSON.stringify(items, null, 2) + "\n",
      "utf8",
    );
  }

  async readMetadata(): Promise<MetadataFile> {
    try {
      return JSON.parse(
        await fs.readFile(localPath(this.root, "metadata"), "utf8"),
      ) as MetadataFile;
    } catch {
      return {};
    }
  }

  async writeMetadata(meta: MetadataFile): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "metadata")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "metadata"),
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

  async loadAll(): Promise<FeatureDetail[]> {
    const [files, meta, items, levels, defaultProductId, statuses, doneKey] =
      await Promise.all([
        this.walkSpecFiles(specsDir(this.root)),
        this.readMetadata(),
        this.readItems(),
        this.readLevels(),
        this.defaultProductId(),
        this.listStatuses(),
        this.doneStatusKey(),
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
    this.attachHierarchy(features, doneKey);
    return features;
  }

  /**
   * Resolve parent titles + direct children + roll-up counts. `doneKey` is the
   * workflow's terminal stage (see {@link LocalFileStore.doneStatusKey}), so the
   * roll-up counts what this workspace calls finished.
   */
  private attachHierarchy(features: FeatureDetail[], doneKey: string): void {
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
      if (isDone(f.status, doneKey)) parent.childDoneCount += 1;
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
  //
  // Implemented in ./items-read.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  listFeatures(scope?: WorkspaceScope): Promise<FeatureRecord[]> {
    return itemReadStore.listFeatures(this, scope);
  }

  listFeatureBodies(
    specIds: readonly string[],
    scope?: WorkspaceScope,
  ): Promise<Map<string, string>> {
    return itemReadStore.listFeatureBodies(this, specIds, scope);
  }

  getFeature(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<FeatureDetail | null> {
    return itemReadStore.getFeature(this, specId, scope);
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
      const release = (await releaseStore.readReleases(this)).find(
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
      const cycle = (await cycleStore.readCycles(this)).find(
        (c) => c.id === input.cycleId,
      );
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
    return {
      since: null,
      total: 0,
      byActor: [],
      byField: [],
      byDay: [],
      stageTime: [],
    };
  }

  // ==========================================================================
  // Saved views and board preferences
  // ==========================================================================
  //
  // Implemented in ./views.ts. The bodies moved verbatim; these delegate so
  // that `LocalFileStore` stays the one thing callers hold.

  listSavedViews(scope?: WorkspaceScope): Promise<SavedView[]> {
    return viewStore.listSavedViews(this, scope);
  }

  createSavedView(
    input: SavedViewInput,
    scope?: WorkspaceScope,
  ): Promise<SavedView> {
    return viewStore.createSavedView(this, input, scope);
  }

  updateSavedView(
    id: string,
    patch: SavedViewPatch,
    scope?: WorkspaceScope,
  ): Promise<SavedView | null> {
    return viewStore.updateSavedView(this, id, patch, scope);
  }

  deleteSavedView(id: string, scope?: WorkspaceScope): Promise<void> {
    return viewStore.deleteSavedView(this, id, scope);
  }

  getBoardPreferences(
    scope?: WorkspaceScope,
    board?: BoardKey,
  ): Promise<BoardPreferences | null> {
    return viewStore.getBoardPreferences(this, scope, board);
  }

  setBoardPreferences(
    prefs: BoardPreferences,
    scope?: WorkspaceScope,
    board?: BoardKey,
  ): Promise<void> {
    return viewStore.setBoardPreferences(this, prefs, scope, board);
  }

  // Custom properties persist to `.specboards/local-properties.json`.
  private async readProperties(): Promise<PropertyDef[]> {
    try {
      return JSON.parse(
        await fs.readFile(localPath(this.root, "properties"), "utf8"),
      ) as PropertyDef[];
    } catch {
      return [];
    }
  }

  private async writeProperties(rows: PropertyDef[]): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "properties")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "properties"),
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
        await fs.readFile(localPath(this.root, "detailTemplates"), "utf8"),
      ) as DetailTemplate[];
    } catch {
      return [];
    }
  }

  private async writeTemplates(rows: DetailTemplate[]): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "detailTemplates")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "detailTemplates"),
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
        await fs.readFile(localPath(this.root, "statuses"), "utf8"),
      ) as WorkspaceStatus[];
      return rows
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((r, i) => ({ ...r, position: i }));
    } catch {
      return [];
    }
  }

  /**
   * The status that means "finished" here: the terminal stage of the configured
   * stages, else of the repo config's vocabulary, else the built-in `done`.
   *
   * Mirrors `resolveWorkflowFor`'s layering, minus the per-product level, which
   * local mode has no way to express (one repo, one stage set). Local mode is
   * the only place the store reads `.specboards/config.yml` itself: in DB mode
   * the config is synced into the `repositories` row the DB store reads.
   */
  async doneStatusKey(): Promise<string> {
    const stages = await this.listStatuses();
    const configured = terminalStatus(stages.map((s) => s.key));
    if (configured) return configured;
    try {
      const raw = await fs.readFile(
        path.join(this.root, ".specboards", "config.yml"),
        "utf8",
      );
      const statuses = parseRepoConfigYaml(raw)?.statuses;
      if (statuses && statuses.length >= 2) {
        const fromConfig = terminalStatus(statuses);
        if (fromConfig) return fromConfig;
      }
    } catch {
      // No config, or an unparseable one: fall through to the built-in stage.
    }
    return terminalStatus(DEFAULT_STATUSES)!;
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
    await fs.mkdir(path.dirname(localPath(this.root, "statuses")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "statuses"),
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
        await fs.readFile(localPath(this.root, "stageGates"), "utf8"),
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
    await fs.mkdir(path.dirname(localPath(this.root, "stageGates")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "stageGates"),
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
        await fs.readFile(localPath(this.root, "gateCompletions"), "utf8"),
      ) as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  private async writeGateCompletions(
    map: Record<string, string[]>,
  ): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "gateCompletions")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "gateCompletions"),
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

  // ==========================================================================
  // Releases
  // ==========================================================================
  //
  // Implemented in ./releases.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  listReleases(scope?: WorkspaceScope): Promise<ReleaseRecord[]> {
    return releaseStore.listReleases(this, scope);
  }

  createRelease(
    input: ReleaseInput,
    scope?: WorkspaceScope,
  ): Promise<ReleaseRecord> {
    return releaseStore.createRelease(this, input, scope);
  }

  updateRelease(
    id: string,
    patch: ReleasePatch,
    scope?: WorkspaceScope,
    emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
  ): Promise<ReleaseRecord> {
    return releaseStore.updateRelease(this, id, patch, scope, emit);
  }

  deleteRelease(id: string, scope?: WorkspaceScope): Promise<void> {
    return releaseStore.deleteRelease(this, id, scope);
  }

  // ── Cycles ────────────────────────────────────────────────────────────
  // Persisted to `.specboards/local-cycles.json`. File mode has no product
  // roles, so the per-product write checks the DB store makes are absent here;
  // every other rule (name uniqueness per scope, date validation, unscheduling
  // on delete, done work staying put on rollover) is the same.

  // ==========================================================================
  // Cycles
  // ==========================================================================
  //
  // Implemented in ./cycles.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  listCycles(scope?: WorkspaceScope): Promise<CycleRecord[]> {
    return cycleStore.listCycles(this, scope);
  }

  createCycle(input: CycleInput, scope?: WorkspaceScope): Promise<CycleRecord> {
    return cycleStore.createCycle(this, input, scope);
  }

  generateCycles(
    input: CycleGenerateInput,
    scope?: WorkspaceScope,
  ): Promise<CycleRecord[]> {
    return cycleStore.generateCycles(this, input, scope);
  }

  updateCycle(
    id: string,
    patch: CyclePatch,
    scope?: WorkspaceScope,
  ): Promise<CycleRecord> {
    return cycleStore.updateCycle(this, id, patch, scope);
  }

  deleteCycle(id: string, scope?: WorkspaceScope): Promise<void> {
    return cycleStore.deleteCycle(this, id, scope);
  }

  rolloverCycle(
    fromId: string,
    toId: string,
    scope?: WorkspaceScope,
  ): Promise<CycleRolloverResult> {
    return cycleStore.rolloverCycle(this, fromId, toId, scope);
  }

  // ── Goals ─────────────────────────────────────────────────────────────
  // Persisted to `.specboards/local-goals.json` (goals with their key results
  // and links nested, since file mode has no joins to do). File mode has no
  // product roles, so the per-product write checks the DB store makes are
  // absent; every other rule is the same, including the two progress figures
  // being computed on read rather than stored.

  // ==========================================================================
  // Goals and key results
  // ==========================================================================
  //
  // Implemented in ./goals.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  listGoals(scope?: WorkspaceScope): Promise<GoalRecord[]> {
    return goalStore.listGoals(this, scope);
  }

  createGoal(input: GoalInput, scope?: WorkspaceScope): Promise<GoalRecord> {
    return goalStore.createGoal(this, input, scope);
  }

  updateGoal(
    id: string,
    patch: GoalPatch,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    return goalStore.updateGoal(this, id, patch, scope);
  }

  deleteGoal(id: string, scope?: WorkspaceScope): Promise<void> {
    return goalStore.deleteGoal(this, id, scope);
  }

  createKeyResult(
    goalId: string,
    input: KeyResultInput,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    return goalStore.createKeyResult(this, goalId, input, scope);
  }

  updateKeyResult(
    id: string,
    patch: KeyResultPatch,
    scope?: WorkspaceScope,
  ): Promise<GoalRecord> {
    return goalStore.updateKeyResult(this, id, patch, scope);
  }

  deleteKeyResult(id: string, scope?: WorkspaceScope): Promise<GoalRecord> {
    return goalStore.deleteKeyResult(this, id, scope);
  }

  listGoalContributions(
    goalId: string,
    scope?: WorkspaceScope,
  ): Promise<GoalContribution[]> {
    return goalStore.listGoalContributions(this, goalId, scope);
  }

  listGoalLinks(scope?: WorkspaceScope): Promise<GoalLinkRef[]> {
    return goalStore.listGoalLinks(this, scope);
  }

  listItemGoals(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<ItemGoalRef[]> {
    return goalStore.listItemGoals(this, specId, scope);
  }

  linkGoal(
    goalId: string,
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return goalStore.linkGoal(this, goalId, specId, scope);
  }

  unlinkGoal(
    goalId: string,
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return goalStore.unlinkGoal(this, goalId, specId, scope);
  }

  // ── Comments ──────────────────────────────────────────────────────────
  // Persisted to `.specboards/local-comments.json`. File mode has no user
  // records, so every comment is authored by LOCAL_USER with a null name.

  // ==========================================================================
  // Comments
  // ==========================================================================
  //
  // Implemented in ./collaboration.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  listComments(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<CommentRecord[]> {
    return collabStore.listComments(this, specId, scope);
  }

  createComment(
    specId: string,
    input: CommentInput,
    scope?: WorkspaceScope,
  ): Promise<CommentRecord> {
    return collabStore.createComment(this, specId, input, scope);
  }

  deleteComment(commentId: string, scope?: WorkspaceScope): Promise<void> {
    return collabStore.deleteComment(this, commentId, scope);
  }

  listNotifications(scope?: WorkspaceScope): Promise<NotificationList> {
    return collabStore.listNotifications(scope);
  }

  markNotificationRead(id: string, scope?: WorkspaceScope): Promise<void> {
    return collabStore.markNotificationRead(id, scope);
  }

  markAllNotificationsRead(scope?: WorkspaceScope): Promise<void> {
    return collabStore.markAllNotificationsRead(scope);
  }

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
      throw new GroupError(
        "Can't delete a group while it still has subgroups.",
      );
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
    const releaseTotals = new Map<
      string,
      Map<string, { total: number; done: number }>
    >();
    for (const f of allFeatures) {
      if (!f.productId) continue;
      const summary = summaries.get(f.productId);
      if (!summary) continue;
      summary.itemCount += 1;
      summary.statusCounts[f.status] =
        (summary.statusCounts[f.status] ?? 0) + 1;
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
    const [products, allFeatures, releases, doneKey] = await Promise.all([
      this.readProducts(),
      this.loadAll(),
      this.listReleases(),
      this.doneStatusKey(),
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
      summary.statusCounts[f.status] =
        (summary.statusCounts[f.status] ?? 0) + 1;
      if (f.releaseId) {
        const byRelease =
          releaseTotals.get(f.productId) ??
          new Map<string, { total: number; done: number }>();
        releaseTotals.set(f.productId, byRelease);
        const entry = byRelease.get(f.releaseId) ?? { total: 0, done: 0 };
        entry.total += 1;
        if (isDone(f.status, doneKey)) entry.done += 1;
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
      (f) => f.status !== "archived" && !isDone(f.status, doneKey),
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
        await fs.readFile(localPath(this.root, "ideas"), "utf8"),
      ) as LocalIdea[];
    } catch {
      return [];
    }
  }

  private async writeIdeas(rows: LocalIdea[]): Promise<void> {
    await fs.mkdir(path.dirname(localPath(this.root, "ideas")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "ideas"),
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
        await fs.readFile(localPath(this.root, "ideaStatuses"), "utf8"),
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
    await fs.mkdir(path.dirname(localPath(this.root, "ideaStatuses")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "ideaStatuses"),
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
    return rows;
  }

  // ==========================================================================
  // Transition mode, property unions, and card configuration
  // ==========================================================================
  //
  // Implemented in ./settings.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  getTransitionMode(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<TransitionMode> {
    return settingsStore.getTransitionMode(scope, productId);
  }

  listTransitionModes(scope?: WorkspaceScope): Promise<TransitionModeSettings> {
    return settingsStore.listTransitionModes(scope);
  }

  cardsOverrides(): Promise<CardsOverrides> {
    return settingsStore.cardsOverrides();
  }

  setTransitionMode(
    mode: TransitionMode | null,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<TransitionMode> {
    return settingsStore.setTransitionMode(mode, scope, productId);
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

  // ==========================================================================
  // Idea settings
  // ==========================================================================

  async getIdeaSettings(_scope?: WorkspaceScope): Promise<IdeaSettings> {
    try {
      const row = JSON.parse(
        await fs.readFile(localPath(this.root, "ideaSettings"), "utf8"),
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
    await fs.mkdir(path.dirname(localPath(this.root, "ideaSettings")), {
      recursive: true,
    });
    await fs.writeFile(
      localPath(this.root, "ideaSettings"),
      JSON.stringify(next, null, 2) + "\n",
      "utf8",
    );
    return next;
  }

  // ── Docs (Plan-section areas) ───────────────────────────────────────────
  // Doc spaces + pages persist to `.specboards/local-doc-*.json`.

  async readJsonFile<T>(file: string): Promise<T[]> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T[];
    } catch {
      return [];
    }
  }

  async writeJsonFile<T>(file: string, rows: T[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(rows, null, 2) + "\n", "utf8");
  }

  // ==========================================================================
  // Doc spaces and pages
  // ==========================================================================
  //
  // Implemented in ./docs.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  getDocSpace(
    productId: string,
    area: DocArea,
    scope?: WorkspaceScope,
  ): Promise<DocSpace> {
    return docStore.getDocSpace(this, productId, area, scope);
  }

  setDocSpace(
    productId: string,
    area: DocArea,
    input: DocSpaceInput,
    scope?: WorkspaceScope,
  ): Promise<DocSpace> {
    return docStore.setDocSpace(this, productId, area, input, scope);
  }

  listDocPages(
    productId: string,
    area: DocArea,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord[]> {
    return docStore.listDocPages(this, productId, area, scope);
  }

  createDocPage(
    input: DocPageInput,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord> {
    return docStore.createDocPage(this, input, scope);
  }

  updateDocPage(
    id: string,
    patch: DocPagePatch,
    scope?: WorkspaceScope,
  ): Promise<DocPageRecord> {
    return docStore.updateDocPage(this, id, patch, scope);
  }

  deleteDocPage(id: string, scope?: WorkspaceScope): Promise<void> {
    return docStore.deleteDocPage(this, id, scope);
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
