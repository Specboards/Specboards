import { promises as fs } from "node:fs";
import path from "node:path";

import {
  leafLevel,
  parseSpec,
  type IdeaStage,
  type PropertyDef,
  type PropertyEntity,
  type WorkspaceLevel,
} from "@specboards/core";

import { riceFields } from "@/lib/feature-helpers";

import { emptyGithubSummary, isDone, type LocalStoreContext } from "./context";
import { localPath, specsDir } from "./paths";
import * as productStore from "./products";
import * as ideaStore from "./ideas";
import * as itemWriteStore from "./items-write";
import * as itemReadStore from "./items-read";
import * as cycleStore from "./cycles";
import * as goalStore from "./goals";
import * as settingsStore from "./settings";
import * as collabStore from "./collaboration";
import * as docStore from "./docs";
import * as releaseStore from "./releases";
import * as viewStore from "./views";
import * as configStore from "./workspace-config";
import {
  type LocalItem,
  localDirection,
  localLinkId,
  type MetadataFile,
} from "./types";
import {
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
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type BlockingEdge,
  type GroupSummary,
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
  type CardsOverrides,
  type StatusStageInput,
  type TransitionModeSettings,
  type WorkspaceStatus,
  type ResolvedGithubLink,
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

  /**
   * A `LocalStoreContext` member whose implementation lives with the products,
   * so there is one of it rather than two. Same pattern as `levelsIn` on the
   * Postgres side.
   */
  defaultProductId(): Promise<string> {
    return productStore.defaultProductId(this);
  }

  /**
   * A `LocalStoreContext` member whose implementation lives with the rest of
   * the workspace configuration, for the same reason `defaultProductId` lives
   * with the products.
   */
  readLevels(): Promise<WorkspaceLevel[] | null> {
    return configStore.readLevels(this);
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

  // ==========================================================================
  // Workspace configuration: levels, detail templates, properties,
  // statuses, and stage gates
  // ==========================================================================
  //
  // Implemented in ./workspace-config.ts. The bodies moved verbatim; these
  // delegate so that `LocalFileStore` stays the one thing callers hold.

  listLevels(scope?: WorkspaceScope): Promise<WorkspaceLevel[]> {
    return configStore.listLevels(this, scope);
  }

  updateLevels(
    updates: LevelUpdate[],
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    return configStore.updateLevels(this, updates, scope);
  }

  updateLevelFields(
    fields: Record<string, string[] | null>,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    return configStore.updateLevelFields(this, fields, scope);
  }

  updateLevelTemplates(
    templates: Record<string, string | null>,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    return configStore.updateLevelTemplates(this, templates, scope);
  }

  listDetailTemplates(scope?: WorkspaceScope): Promise<DetailTemplate[]> {
    return configStore.listDetailTemplates(this, scope);
  }

  createDetailTemplate(
    input: DetailTemplateInput,
    scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    return configStore.createDetailTemplate(this, input, scope);
  }

  updateDetailTemplate(
    id: string,
    patch: DetailTemplatePatch,
    scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    return configStore.updateDetailTemplate(this, id, patch, scope);
  }

  deleteDetailTemplate(id: string, scope?: WorkspaceScope): Promise<void> {
    return configStore.deleteDetailTemplate(this, id, scope);
  }

  listProperties(
    scope?: WorkspaceScope,
    entity?: PropertyEntity,
  ): Promise<PropertyDef[]> {
    return configStore.listProperties(this, scope, entity);
  }

  listPropertiesUnion(
    scope: WorkspaceScope | undefined,
    productIds: string[] | null,
    entity?: PropertyEntity,
  ): Promise<PropertyDef[]> {
    return configStore.listPropertiesUnion(this, scope, productIds, entity);
  }

  createProperty(
    input: PropertyInput,
    scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    return configStore.createProperty(this, input, scope);
  }

  updateProperty(
    id: string,
    patch: PropertyPatch,
    scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    return configStore.updateProperty(this, id, patch, scope);
  }

  deleteProperty(id: string, scope?: WorkspaceScope): Promise<void> {
    return configStore.deleteProperty(this, id, scope);
  }

  listStatuses(scope?: WorkspaceScope): Promise<WorkspaceStatus[]> {
    return configStore.listStatuses(this, scope);
  }

  listStatusesUnion(
    scope: WorkspaceScope | undefined,
    productIds: string[] | null,
  ): Promise<WorkspaceStatus[]> {
    return configStore.listStatusesUnion(this, scope, productIds);
  }

  /**
   * A `LocalStoreContext` member, delegated like the rest of the domain: it is
   * the last of the configured stages, so it belongs with them.
   */
  doneStatusKey(): Promise<string> {
    return configStore.doneStatusKey(this);
  }

  replaceStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
  ): Promise<WorkspaceStatus[]> {
    return configStore.replaceStatuses(this, stages, scope);
  }

  listStageGates(scope?: WorkspaceScope): Promise<StageGate[]> {
    return configStore.listStageGates(this, scope);
  }

  replaceStageGates(
    gates: StageGateInput[],
    scope?: WorkspaceScope,
  ): Promise<StageGate[]> {
    return configStore.replaceStageGates(this, gates, scope);
  }

  listGateCompletions(
    specId: string,
    scope?: WorkspaceScope,
  ): Promise<string[]> {
    return configStore.listGateCompletions(this, specId, scope);
  }

  setGateCompletion(
    specId: string,
    gateId: string,
    completed: boolean,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return configStore.setGateCompletion(
      this,
      specId,
      gateId,
      completed,
      scope,
    );
  }

  // ==========================================================================
  // Items: write, relations, GitHub links, and the event ledger
  // ==========================================================================
  //
  // Implemented in ./items-write.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  createFeature(
    input: CreateFeatureInput,
    scope?: WorkspaceScope,
    emitType?: string, // webhooks are DB-only; ignored in local file mode
  ): Promise<FeatureRecord> {
    return itemWriteStore.createFeature(this, input, scope, emitType);
  }

  deleteFeature(
    specId: string,
    scope?: WorkspaceScope,
    emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
    opts?: DeleteFeatureOptions,
  ): Promise<void> {
    return itemWriteStore.deleteFeature(this, specId, scope, emit, opts);
  }

  pruneAutoGrouping(specId: string, scope?: WorkspaceScope): Promise<boolean> {
    return itemWriteStore.pruneAutoGrouping(specId, scope);
  }

  updateFeature(
    specId: string,
    patch: FeaturePatch,
    scope?: WorkspaceScope,
    emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
  ): Promise<void> {
    return itemWriteStore.updateFeature(this, specId, patch, scope, emit);
  }

  addRelation(
    specId: string,
    input: RelationInput,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return itemWriteStore.addRelation(this, specId, input, scope);
  }

  removeRelation(
    specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return itemWriteStore.removeRelation(this, specId, linkId, scope);
  }

  addGithubLink(
    specId: string,
    link: ResolvedGithubLink,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return itemWriteStore.addGithubLink(specId, link, scope);
  }

  removeGithubLink(
    specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return itemWriteStore.removeGithubLink(specId, linkId, scope);
  }

  listItemEvents(
    specId: string,
    scope?: WorkspaceScope,
    limit?: number,
  ): Promise<ItemEvent[]> {
    return itemWriteStore.listItemEvents(specId, scope, limit);
  }

  itemActivitySummary(
    query: ActivityQuery,
    scope?: WorkspaceScope,
  ): Promise<ActivitySummary> {
    return itemWriteStore.itemActivitySummary(query, scope);
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
  //
  // Implemented in ./products.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  getProductAccess(scope?: WorkspaceScope): Promise<ProductAccess> {
    return productStore.getProductAccess(scope);
  }

  listProducts(scope?: WorkspaceScope): Promise<ProductRecord[]> {
    return productStore.listProducts(this, scope);
  }

  getProduct(
    key: string,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord | null> {
    return productStore.getProduct(this, key, scope);
  }

  createProduct(
    input: CreateProductInput,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    return productStore.createProduct(this, input, scope);
  }

  updateProduct(
    id: string,
    patch: ProductPatch,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    return productStore.updateProduct(this, id, patch, scope);
  }

  deleteProduct(id: string, scope?: WorkspaceScope): Promise<void> {
    return productStore.deleteProduct(this, id, scope);
  }

  listProductGroups(scope?: WorkspaceScope): Promise<ProductGroupRecord[]> {
    return productStore.listProductGroups(this, scope);
  }

  createProductGroup(
    input: CreateProductGroupInput,
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord> {
    return productStore.createProductGroup(this, input, scope);
  }

  updateProductGroup(
    id: string,
    patch: ProductGroupPatch,
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord> {
    return productStore.updateProductGroup(this, id, patch, scope);
  }

  deleteProductGroup(id: string, scope?: WorkspaceScope): Promise<void> {
    return productStore.deleteProductGroup(this, id, scope);
  }

  getGroupSummary(id: string, scope?: WorkspaceScope): Promise<GroupSummary> {
    return productStore.getGroupSummary(this, id, scope);
  }

  listBlockingEdges(scope?: WorkspaceScope): Promise<BlockingEdge[]> {
    return productStore.listBlockingEdges(this, scope);
  }

  getWorkspaceSummary(
    options: WorkspaceSummaryOptions,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceSummary> {
    return productStore.getWorkspaceSummary(this, options, scope);
  }

  listProductMembers(
    productId: string,
    scope?: WorkspaceScope,
  ): Promise<ProductMemberRecord[]> {
    return productStore.listProductMembers(productId, scope);
  }

  setProductMember(
    productId: string,
    input: ProductMemberInput,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return productStore.setProductMember(productId, input, scope);
  }

  removeProductMember(
    productId: string,
    userId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return productStore.removeProductMember(productId, userId, scope);
  }

  // ==========================================================================
  // Ideas
  // ==========================================================================
  //
  // Implemented in ./ideas.ts. The bodies moved verbatim; these delegate
  // so that `LocalFileStore` stays the one thing callers hold.

  listIdeas(scope?: WorkspaceScope): Promise<IdeaRecord[]> {
    return ideaStore.listIdeas(this, scope);
  }

  createIdea(input: IdeaInput, scope?: WorkspaceScope): Promise<IdeaRecord> {
    return ideaStore.createIdea(this, input, scope);
  }

  updateIdea(
    id: string,
    patch: IdeaPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaRecord> {
    return ideaStore.updateIdea(this, id, patch, scope);
  }

  deleteIdea(id: string, scope?: WorkspaceScope): Promise<void> {
    return ideaStore.deleteIdea(this, id, scope);
  }

  voteIdea(id: string, scope?: WorkspaceScope): Promise<IdeaRecord> {
    return ideaStore.voteIdea(this, id, scope);
  }

  unvoteIdea(id: string, scope?: WorkspaceScope): Promise<IdeaRecord> {
    return ideaStore.unvoteIdea(this, id, scope);
  }

  promoteIdea(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
    return ideaStore.promoteIdea(this, id, scope);
  }

  listIdeaStatuses(scope?: WorkspaceScope): Promise<IdeaStage[]> {
    return ideaStore.listIdeaStatuses(this, scope);
  }

  replaceIdeaStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
  ): Promise<IdeaStage[]> {
    return ideaStore.replaceIdeaStatuses(this, stages, scope);
  }

  getIdeaSettings(scope?: WorkspaceScope): Promise<IdeaSettings> {
    return ideaStore.getIdeaSettings(this, scope);
  }

  updateIdeaSettings(
    patch: IdeaSettingsPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaSettings> {
    return ideaStore.updateIdeaSettings(this, patch, scope);
  }

  // ==========================================================================
  // Transition mode and card configuration
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
