import {
  type IdeaStage,
  type PropertyDef,
  type PropertyEntity,
  type TransitionMode,
  type WorkspaceLevel,
} from "@specboards/core";

import {
  createDb,
  outboxEvents,
  sql,
  specIndex,
  type Database,
} from "@specboards/db";

import {
  type CommentInput,
  type CommentRecord,
  type NotificationList,
  type BoardKey,
  type BoardPreferences,
  type CreateFeatureInput,
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
  type OutboxEmit,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureStore,
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type CreateProductGroupInput,
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
  type RelationInput,
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
  type SavedView,
  type SavedViewInput,
  type SavedViewPatch,
  type ActivityQuery,
  type ActivitySummary,
  type ItemEvent,
  type WorkspaceScope,
} from "../types";

import {
  type DbStoreContext,
  type ProductVisibilityRow,
  type Tx,
} from "./context";
import * as collabStore from "./collaboration";
import * as configStore from "./workspace-config";
import * as cycleStore from "./cycles";
import * as goalStore from "./goals";
import * as ideaStore from "./ideas";
import * as itemReadStore from "./items-read";
import * as itemWriteStore from "./items-write";
import * as productStore from "./products";
import * as docStore from "./docs";
import * as releaseStore from "./releases";
import * as settingsStore from "./settings";
import * as viewStore from "./views";

/**
 * Postgres-backed store (self-host compose stack or hosted Postgres).
 *
 * Also implements `DbStoreContext`, the small surface the domain modules in
 * this directory call back into. That is why `scoped`, `accessIn` and
 * `requireProductId` are not `private`: they are internal to `lib/store/db/`,
 * not part of what a caller outside it should reach for.
 */
export class DbStore implements FeatureStore, DbStoreContext {
  private readonly db: Database;

  constructor(connectionString: string) {
    this.db = createDb(connectionString);
  }

  /**
   * Run `fn` inside a transaction scoped to `scope`: it sets the
   * `app.user_id` session variable RLS keys on (transaction-local, so it must
   * live in a transaction), and callers additionally filter by `workspaceId`.
   * Refuses to run unscoped because an unset `app.user_id` is not a safe
   * default: on a self-host without `DATABASE_URL_APP` this store is still the
   * owner connection, where every policy is bypassed and the `workspaceId`
   * predicate is all that stands between tenants.
   *
   * The `specboards_app` non-owner role has landed, so on a hosted deployment
   * the policies do apply here. This is the one connection where that is true.
   * See the note on `getDb()` in lib/db.ts for the paths where it is not.
   */
  async scoped<T>(
    scope: WorkspaceScope | undefined,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (!scope) {
      throw new Error("DbStore requires a workspace scope.");
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.user_id', ${scope.userId}, true)`,
      );
      return fn(tx);
    });
  }

  /**
   * Append a transactional-outbox row. Called from inside a mutating method's
   * `scoped` transaction so the event commits atomically with the change that
   * produced it. `actorId`/`workspaceId` come from the scope; the rest is the
   * caller's opaque event.
   */
  async writeOutbox(
    tx: Tx,
    scope: WorkspaceScope,
    emit: OutboxEmit,
  ): Promise<void> {
    await tx.insert(outboxEvents).values({
      workspaceId: scope.workspaceId,
      productId: emit.productId,
      actorId: scope.userId,
      type: emit.type,
      data: emit.data,
    });
  }

  // ==========================================================================
  // Items: read
  // ==========================================================================
  //
  // Implemented in ./items-read.ts. The bodies moved verbatim; these
  // delegate so that `DbStore` stays the one thing callers hold.

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
  // delegate so that `DbStore` stays the one thing callers hold.

  listLevels(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]> {
    return configStore.listLevels(this, scope, productId);
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
    productId?: string | null,
  ): Promise<WorkspaceLevel[]> {
    return configStore.updateLevelFields(this, fields, scope, productId);
  }

  updateLevelTemplates(
    templates: Record<string, string | null>,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]> {
    return configStore.updateLevelTemplates(this, templates, scope, productId);
  }

  listDetailTemplates(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<DetailTemplate[]> {
    return configStore.listDetailTemplates(this, scope, productId);
  }

  createDetailTemplate(
    input: DetailTemplateInput,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<DetailTemplate> {
    return configStore.createDetailTemplate(this, input, scope, productId);
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
    productId?: string | null,
  ): Promise<PropertyDef[]> {
    return configStore.listProperties(this, scope, entity, productId);
  }

  listPropertiesUnion(
    scope: WorkspaceScope | undefined,
    productIds: string[] | null,
    entity?: PropertyEntity,
  ): Promise<PropertyDef[]> {
    return configStore.listPropertiesUnion(this, scope, productIds, entity);
  }

  listStatuses(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceStatus[]> {
    return configStore.listStatuses(this, scope, productId);
  }

  listStatusesUnion(
    scope: WorkspaceScope | undefined,
    productIds: string[] | null,
  ): Promise<WorkspaceStatus[]> {
    return configStore.listStatusesUnion(this, scope, productIds);
  }

  replaceStatuses(
    stages: StatusStageInput[],
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<WorkspaceStatus[]> {
    return configStore.replaceStatuses(this, stages, scope, productId);
  }

  listStageGates(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<StageGate[]> {
    return configStore.listStageGates(this, scope, productId);
  }

  replaceStageGates(
    gates: StageGateInput[],
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<StageGate[]> {
    return configStore.replaceStageGates(this, gates, scope, productId);
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

  createProperty(
    input: PropertyInput,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<PropertyDef> {
    return configStore.createProperty(this, input, scope, productId);
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

  // `levelsIn` is a DbStoreContext member, so it stays a method on the
  // store and delegates like the rest of the domain.
  levelsIn(
    tx: Tx,
    workspaceId: string,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]> {
    return configStore.levelsIn(this, tx, workspaceId, productId);
  }

  // ==========================================================================
  // Items: write, relations, GitHub links, and the event ledger
  // ==========================================================================
  //
  // Implemented in ./items-write.ts. The bodies moved verbatim; these
  // delegate so that `DbStore` stays the one thing callers hold.

  createFeature(
    input: CreateFeatureInput,
    scope?: WorkspaceScope,
    emitType?: string,
  ): Promise<FeatureRecord> {
    return itemWriteStore.createFeature(this, input, scope, emitType);
  }

  deleteFeature(
    specId: string,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
    opts?: DeleteFeatureOptions,
  ): Promise<void> {
    return itemWriteStore.deleteFeature(this, specId, scope, emit, opts);
  }

  pruneAutoGrouping(specId: string, scope?: WorkspaceScope): Promise<boolean> {
    return itemWriteStore.pruneAutoGrouping(this, specId, scope);
  }

  updateFeature(
    specId: string,
    patch: FeaturePatch,
    scope?: WorkspaceScope,
    emit?: OutboxEmit,
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
    return itemWriteStore.addGithubLink(this, specId, link, scope);
  }

  listItemEvents(
    specId: string,
    scope?: WorkspaceScope,
    limit?: number,
  ): Promise<ItemEvent[]> {
    return itemWriteStore.listItemEvents(this, specId, scope, limit);
  }

  itemActivitySummary(
    query: ActivityQuery,
    scope?: WorkspaceScope,
  ): Promise<ActivitySummary> {
    return itemWriteStore.itemActivitySummary(this, query, scope);
  }

  removeGithubLink(
    specId: string,
    linkId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return itemWriteStore.removeGithubLink(this, specId, linkId, scope);
  }

  // ==========================================================================
  // Saved views and board preferences
  // ==========================================================================
  //
  // Implemented in ./views.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

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

  // ── Custom properties ─────────────────────────────────────────────────

  // ── Releases ──────────────────────────────────────────────────────────

  // ==========================================================================
  // Releases
  // ==========================================================================
  //
  // Implemented in ./releases.ts. The bodies moved verbatim; these delegate
  // so that `DbStore` stays the one thing callers hold.

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
    emit?: OutboxEmit,
  ): Promise<ReleaseRecord> {
    return releaseStore.updateRelease(this, id, patch, scope, emit);
  }

  deleteRelease(id: string, scope?: WorkspaceScope): Promise<void> {
    return releaseStore.deleteRelease(this, id, scope);
  }

  // ==========================================================================
  // Cycles
  // ==========================================================================
  //
  // Implemented in ./cycles.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

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

  // ==========================================================================
  // Goals and key results
  // ==========================================================================
  //
  // Implemented in ./goals.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

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

  // ==========================================================================
  // Comments
  // ==========================================================================
  //
  // Implemented in ./collaboration.ts. The bodies moved verbatim; these
  // delegate so that `DbStore` stays the one thing callers hold.

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

  // ── Notifications ─────────────────────────────────────────────────────

  // ==========================================================================
  // Notifications
  // ==========================================================================

  listNotifications(scope?: WorkspaceScope): Promise<NotificationList> {
    return collabStore.listNotifications(this, scope);
  }

  markNotificationRead(id: string, scope?: WorkspaceScope): Promise<void> {
    return collabStore.markNotificationRead(this, id, scope);
  }

  markAllNotificationsRead(scope?: WorkspaceScope): Promise<void> {
    return collabStore.markAllNotificationsRead(this, scope);
  }

  // ── Ideas ─────────────────────────────────────────────────────────────

  // ==========================================================================
  // Ideas
  // ==========================================================================
  //
  // Implemented in ./ideas.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

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

  // ==========================================================================
  // Transition mode and per-product card configuration
  // ==========================================================================
  //
  // Implemented in ./settings.ts. The bodies moved verbatim; these delegate
  // so that `DbStore` stays the one thing callers hold.

  getTransitionMode(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<TransitionMode> {
    return settingsStore.getTransitionMode(this, scope, productId);
  }

  setTransitionMode(
    mode: TransitionMode | null,
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<TransitionMode> {
    return settingsStore.setTransitionMode(this, mode, scope, productId);
  }

  cardsOverrides(
    scope?: WorkspaceScope,
    productId?: string | null,
  ): Promise<CardsOverrides> {
    return settingsStore.cardsOverrides(this, scope, productId);
  }

  listTransitionModes(scope?: WorkspaceScope): Promise<TransitionModeSettings> {
    return settingsStore.listTransitionModes(this, scope);
  }

  // ==========================================================================
  // Idea settings
  // ==========================================================================
  //
  // Implemented in ./ideas.ts, alongside the ideas they configure.

  getIdeaSettings(scope?: WorkspaceScope): Promise<IdeaSettings> {
    return ideaStore.getIdeaSettings(this, scope);
  }

  updateIdeaSettings(
    patch: IdeaSettingsPatch,
    scope?: WorkspaceScope,
  ): Promise<IdeaSettings> {
    return ideaStore.updateIdeaSettings(this, patch, scope);
  }

  // ── Docs (Plan-section areas) ───────────────────────────────────────────

  // ==========================================================================
  // Doc spaces and pages
  // ==========================================================================
  //
  // Implemented in ./docs.ts. The bodies moved verbatim; these delegate so
  // that `DbStore` stays the one thing callers hold.

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

  // ── Products ────────────────────────────────────────────────────────────

  // ==========================================================================
  // Products, product groups, members, and roll-up summaries
  // ==========================================================================
  //
  // Implemented in ./products.ts. The bodies moved verbatim; these delegate
  // so that `DbStore` stays the one thing callers hold.

  getProductAccess(scope?: WorkspaceScope): Promise<ProductAccess> {
    return productStore.getProductAccess(this, scope);
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
    return productStore.listProductMembers(this, productId, scope);
  }

  setProductMember(
    productId: string,
    input: ProductMemberInput,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return productStore.setProductMember(this, productId, input, scope);
  }

  removeProductMember(
    productId: string,
    userId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    return productStore.removeProductMember(this, productId, userId, scope);
  }

  // Five DbStoreContext members live in ./products.ts, because every one of
  // them is a question about products. They delegate like the rest.

  accessIn(tx: Tx, scope: WorkspaceScope): Promise<ProductAccess> {
    return productStore.accessIn(this, tx, scope);
  }

  productVisibilityIn(
    tx: Tx,
    workspaceId: string,
  ): Promise<Map<string, ProductVisibilityRow>> {
    return productStore.productVisibilityIn(this, tx, workspaceId);
  }

  requireProductId(tx: Tx, ws: string, productId: string): Promise<string> {
    return productStore.requireProductId(this, tx, ws, productId);
  }

  defaultProductId(tx: Tx, ws: string): Promise<string> {
    return productStore.defaultProductId(this, tx, ws);
  }

  assertWorkspaceMember(tx: Tx, ws: string, userId: string): Promise<void> {
    return productStore.assertWorkspaceMember(this, tx, ws, userId);
  }
}

export { specIndex };
