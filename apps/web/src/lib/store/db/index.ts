import {
  canReadProduct,
  DEFAULT_PRODUCT_KEY,
  descendantGroupIds,
  groupKeyFromName,
  wouldCreateCycle,
  wouldExceedDepth,
  productKeyFromName,
  type IdeaStage,
  type PropertyDef,
  type PropertyEntity,
  type TransitionMode,
  type WorkspaceLevel,
} from "@specboards/core";

import {
  and,
  asc,
  count,
  createDb,
  eq,
  featureLinks,
  features,
  inArray,
  lt,
  members,
  ne,
  outboxEvents,
  productGroups,
  productMembers,
  products,
  releases,
  sql,
  specIndex,
  users,
  type Database,
} from "@specboards/db";

import {
  FeatureError,
  GroupError,
  ProductError,
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
  type GroupProductSummary,
  type GroupSummary,
  SIGNAL_SAMPLE_LIMIT,
  type SignalItem,
  type WorkspaceSignals,
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
  canReadProductId,
  doneStatusesIn,
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

  /** The workspace's default product id, creating it if it's somehow missing. */
  async defaultProductId(tx: Tx, ws: string): Promise<string> {
    const existing = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.workspaceId, ws),
          eq(products.key, DEFAULT_PRODUCT_KEY),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].id;
    const [created] = await tx
      .insert(products)
      .values({
        workspaceId: ws,
        key: DEFAULT_PRODUCT_KEY,
        name: "General",
        position: 0,
      })
      .onConflictDoNothing({ target: [products.workspaceId, products.key] })
      .returning({ id: products.id });
    if (created) return created.id;
    // Lost an insert race, so re-read.
    const row = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.workspaceId, ws),
          eq(products.key, DEFAULT_PRODUCT_KEY),
        ),
      )
      .limit(1);
    if (!row[0])
      throw new ProductError("Could not resolve the default product.");
    return row[0].id;
  }

  /** Verify a product id belongs to the workspace, returning it. */
  async requireProductId(
    tx: Tx,
    ws: string,
    productId: string,
  ): Promise<string> {
    const row = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.workspaceId, ws)))
      .limit(1);
    if (!row[0]) throw new ProductError(`Unknown product: ${productId}`);
    return row[0].id;
  }

  // ==========================================================================
  // Products, product groups, members, and roll-up summaries
  // ==========================================================================

  async getProductAccess(scope?: WorkspaceScope): Promise<ProductAccess> {
    return this.scoped(scope, (tx) => this.accessIn(tx, scope!));
  }

  /**
   * Assert `userId` is a member of `ws`. Guards fields that reference a user by
   * id (assignee, product-member target) so a caller can't point them at an
   * arbitrary global user id (e.g. someone in another workspace).
   */
  async assertWorkspaceMember(
    tx: Tx,
    ws: string,
    userId: string,
  ): Promise<void> {
    const row = await tx
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, ws), eq(members.userId, userId)))
      .limit(1);
    if (!row[0]) {
      throw new FeatureError("That user is not a member of this workspace.");
    }
  }

  /** Build the acting user's product access (org-admin flag + per-product roles). */
  async accessIn(tx: Tx, scope: WorkspaceScope): Promise<ProductAccess> {
    const membership = await tx
      .select({ role: members.role })
      .from(members)
      .where(
        and(
          eq(members.workspaceId, scope.workspaceId),
          eq(members.userId, scope.userId),
        ),
      )
      .limit(1);
    const mine = await tx
      .select({
        productId: productMembers.productId,
        role: productMembers.role,
      })
      .from(productMembers)
      .where(
        and(
          eq(productMembers.workspaceId, scope.workspaceId),
          eq(productMembers.userId, scope.userId),
        ),
      );
    const roles = new Map(mine.map((g) => [g.productId, g.role] as const));
    return { isOrgAdmin: membership[0]?.role === "owner", roles };
  }

  /** Product visibility by id for owner-connection app-side RLS mirroring. */
  async productVisibilityIn(
    tx: Tx,
    workspaceId: string,
  ): Promise<Map<string, ProductVisibilityRow>> {
    const rows = await tx
      .select({ id: products.id, visibility: products.visibility })
      .from(products)
      .where(eq(products.workspaceId, workspaceId));
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Item counts per product across the workspace. */
  private async itemCounts(tx: Tx, ws: string): Promise<Map<string, number>> {
    const rows = await tx
      .select({ productId: features.productId, n: count() })
      .from(features)
      .where(eq(features.workspaceId, ws))
      .groupBy(features.productId);
    const out = new Map<string, number>();
    for (const r of rows) if (r.productId) out.set(r.productId, Number(r.n));
    return out;
  }

  async listProducts(scope?: WorkspaceScope): Promise<ProductRecord[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [rows, counts, access] = await Promise.all([
        tx
          .select()
          .from(products)
          .where(eq(products.workspaceId, ws))
          .orderBy(asc(products.position), asc(products.name)),
        this.itemCounts(tx, ws),
        this.accessIn(tx, scope!),
      ]);
      return rows
        .filter((p) => canReadProduct(access, p))
        .map((p) => ({
          id: p.id,
          key: p.key,
          name: p.name,
          description: p.description,
          visibility: p.visibility,
          position: p.position,
          color: p.color,
          groupId: p.groupId,
          itemCount: counts.get(p.id) ?? 0,
          viewerRole: access.roles.get(p.id) ?? null,
        }));
    });
  }

  async getProduct(
    key: string,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord | null> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const row = await tx.query.products.findFirst({
        where: and(eq(products.workspaceId, ws), eq(products.key, key)),
      });
      if (!row) return null;
      const access = await this.accessIn(tx, scope!);
      if (!canReadProduct(access, row)) return null;
      const counts = await this.itemCounts(tx, ws);
      return {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        position: row.position,
        color: row.color,
        groupId: row.groupId,
        itemCount: counts.get(row.id) ?? 0,
        viewerRole: access.roles.get(row.id) ?? null,
      };
    });
  }

  async createProduct(
    input: CreateProductInput,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const name = input.name.trim();
      if (!name) throw new ProductError("Product name is required.");
      const taken = new Set(
        (
          await tx
            .select({ key: products.key })
            .from(products)
            .where(eq(products.workspaceId, ws))
        ).map((r) => r.key),
      );
      const key = productKeyFromName(name, taken);
      const max = await tx
        .select({ m: sql<number>`coalesce(max(${products.position}), -1)` })
        .from(products)
        .where(eq(products.workspaceId, ws));
      const [row] = await tx
        .insert(products)
        .values({
          workspaceId: ws,
          key,
          name,
          description: input.description ?? null,
          visibility: input.visibility ?? "org",
          color: input.color ?? null,
          position: Number(max[0]?.m ?? -1) + 1,
        })
        .returning();
      if (!row) throw new ProductError("Failed to create product.");
      // Make the creator an explicit admin of the product they just created.
      // Org admins already have full access via RLS, but recording membership
      // keeps them in the product's member list and preserves their standing
      // if they are later demoted from org admin.
      await tx
        .insert(productMembers)
        .values({
          workspaceId: ws,
          productId: row.id,
          userId: scope!.userId,
          role: "admin",
        })
        .onConflictDoUpdate({
          target: [productMembers.productId, productMembers.userId],
          set: { role: "admin" },
        });
      return {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        position: row.position,
        color: row.color,
        groupId: row.groupId,
        itemCount: 0,
        viewerRole: "admin",
      };
    });
  }

  async updateProduct(
    id: string,
    patch: ProductPatch,
    scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new ProductError("Product name is required.");
        set.name = name;
      }
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.visibility !== undefined) {
        // Changing visibility can expose a private product to the whole org (or
        // hide an org one), so restrict it to org admins even though a product
        // admin may otherwise manage the product's settings.
        const current = await tx
          .select({ visibility: products.visibility })
          .from(products)
          .where(and(eq(products.id, id), eq(products.workspaceId, ws)))
          .limit(1);
        if (
          current[0] &&
          current[0].visibility !== patch.visibility &&
          !(await this.accessIn(tx, scope!)).isOrgAdmin
        ) {
          throw new ProductError(
            "Only the workspace owner can change a product's visibility.",
          );
        }
        set.visibility = patch.visibility;
      }
      if (patch.position !== undefined) set.position = patch.position;
      if (patch.color !== undefined) set.color = patch.color;
      if (patch.groupId !== undefined) {
        if (patch.groupId !== null) {
          await this.requireGroupId(tx, ws, patch.groupId);
        }
        set.groupId = patch.groupId;
      }
      const [row] = await tx
        .update(products)
        .set(set)
        .where(and(eq(products.id, id), eq(products.workspaceId, ws)))
        .returning();
      if (!row) throw new ProductError(`Unknown product: ${id}`);
      const counts = await this.itemCounts(tx, ws);
      const access = await this.accessIn(tx, scope!);
      return {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        position: row.position,
        color: row.color,
        groupId: row.groupId,
        itemCount: counts.get(row.id) ?? 0,
        viewerRole: access.roles.get(row.id) ?? null,
      };
    });
  }

  async deleteProduct(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const used = await tx
        .select({ n: count() })
        .from(features)
        .where(and(eq(features.workspaceId, ws), eq(features.productId, id)));
      if (Number(used[0]?.n ?? 0) > 0) {
        throw new ProductError(
          "Can't delete a product while it still has work items.",
        );
      }
      const deleted = await tx
        .delete(products)
        .where(and(eq(products.id, id), eq(products.workspaceId, ws)))
        .returning({ id: products.id });
      if (!deleted[0]) throw new ProductError(`Unknown product: ${id}`);
    });
  }

  /** Verify a group id belongs to the workspace, returning it. */
  private async requireGroupId(
    tx: Tx,
    ws: string,
    groupId: string,
  ): Promise<string> {
    const row = await tx
      .select({ id: productGroups.id })
      .from(productGroups)
      .where(
        and(eq(productGroups.id, groupId), eq(productGroups.workspaceId, ws)),
      )
      .limit(1);
    if (!row[0]) throw new GroupError(`Unknown product group: ${groupId}`);
    return row[0].id;
  }

  /** Direct-member product counts per group across the workspace. */
  private async groupProductCounts(
    tx: Tx,
    ws: string,
  ): Promise<Map<string, number>> {
    const rows = await tx
      .select({ groupId: products.groupId, n: count() })
      .from(products)
      .where(eq(products.workspaceId, ws))
      .groupBy(products.groupId);
    const out = new Map<string, number>();
    for (const r of rows) if (r.groupId) out.set(r.groupId, Number(r.n));
    return out;
  }

  private groupRecord(
    row: typeof productGroups.$inferSelect,
    counts: Map<string, number>,
  ): ProductGroupRecord {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      color: row.color,
      parentId: row.parentId,
      position: row.position,
      productCount: counts.get(row.id) ?? 0,
    };
  }

  async listProductGroups(
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [rows, counts] = await Promise.all([
        tx
          .select()
          .from(productGroups)
          .where(eq(productGroups.workspaceId, ws))
          .orderBy(asc(productGroups.position), asc(productGroups.name)),
        this.groupProductCounts(tx, ws),
      ]);
      return rows.map((row) => this.groupRecord(row, counts));
    });
  }

  async createProductGroup(
    input: CreateProductGroupInput,
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const name = input.name.trim();
      if (!name) throw new GroupError("Group name is required.");
      const existing = await tx
        .select({
          id: productGroups.id,
          parentId: productGroups.parentId,
          key: productGroups.key,
          position: productGroups.position,
        })
        .from(productGroups)
        .where(eq(productGroups.workspaceId, ws));
      const parentId = input.parentId ?? null;
      if (parentId) {
        await this.requireGroupId(tx, ws, parentId);
        if (wouldExceedDepth(existing, "new-group", parentId)) {
          throw new GroupError("Groups can only be nested a few levels deep.");
        }
      }
      const key = groupKeyFromName(name, new Set(existing.map((g) => g.key)));
      const position =
        existing.reduce((m, g) => Math.max(m, g.position), -1) + 1;
      const [row] = await tx
        .insert(productGroups)
        .values({
          workspaceId: ws,
          key,
          name,
          description: input.description ?? null,
          color: input.color ?? null,
          parentId,
          position,
        })
        .returning();
      if (!row) throw new GroupError("Failed to create group.");
      return this.groupRecord(row, new Map());
    });
  }

  async updateProductGroup(
    id: string,
    patch: ProductGroupPatch,
    scope?: WorkspaceScope,
  ): Promise<ProductGroupRecord> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new GroupError("Group name is required.");
        set.name = name;
      }
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.color !== undefined) set.color = patch.color;
      if (patch.position !== undefined) set.position = patch.position;
      if (patch.parentId !== undefined) {
        if (patch.parentId !== null) {
          await this.requireGroupId(tx, ws, patch.parentId);
          const existing = await tx
            .select({
              id: productGroups.id,
              parentId: productGroups.parentId,
            })
            .from(productGroups)
            .where(eq(productGroups.workspaceId, ws));
          if (wouldCreateCycle(existing, id, patch.parentId)) {
            throw new GroupError(
              "A group can't be nested inside itself or its own subgroups.",
            );
          }
          if (wouldExceedDepth(existing, id, patch.parentId)) {
            throw new GroupError(
              "Groups can only be nested a few levels deep.",
            );
          }
        }
        set.parentId = patch.parentId;
      }
      const [row] = await tx
        .update(productGroups)
        .set(set)
        .where(and(eq(productGroups.id, id), eq(productGroups.workspaceId, ws)))
        .returning();
      if (!row) throw new GroupError(`Unknown product group: ${id}`);
      const counts = await this.groupProductCounts(tx, ws);
      return this.groupRecord(row, counts);
    });
  }

  async deleteProductGroup(id: string, scope?: WorkspaceScope): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [children, memberProducts] = await Promise.all([
        tx
          .select({ n: count() })
          .from(productGroups)
          .where(
            and(
              eq(productGroups.workspaceId, ws),
              eq(productGroups.parentId, id),
            ),
          ),
        tx
          .select({ n: count() })
          .from(products)
          .where(and(eq(products.workspaceId, ws), eq(products.groupId, id))),
      ]);
      if (Number(children[0]?.n ?? 0) > 0) {
        throw new GroupError(
          "Can't delete a group while it still has subgroups.",
        );
      }
      if (Number(memberProducts[0]?.n ?? 0) > 0) {
        throw new GroupError(
          "Can't delete a group while it still has products.",
        );
      }
      const deleted = await tx
        .delete(productGroups)
        .where(and(eq(productGroups.id, id), eq(productGroups.workspaceId, ws)))
        .returning({ id: productGroups.id });
      if (!deleted[0]) throw new GroupError(`Unknown product group: ${id}`);
    });
  }

  async getGroupSummary(
    id: string,
    scope?: WorkspaceScope,
  ): Promise<GroupSummary> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [groupRows, counts, access] = await Promise.all([
        tx
          .select()
          .from(productGroups)
          .where(eq(productGroups.workspaceId, ws))
          .orderBy(asc(productGroups.position), asc(productGroups.name)),
        this.groupProductCounts(tx, ws),
        this.accessIn(tx, scope!),
      ]);
      const group = groupRows.find((g) => g.id === id);
      if (!group) throw new GroupError(`Unknown product group: ${id}`);

      // Aggregates only ever cover products the viewer can read; a private
      // product in the subtree simply doesn't contribute (matching listProducts).
      const subtree = descendantGroupIds(groupRows, id);
      const productRows = await tx
        .select()
        .from(products)
        .where(eq(products.workspaceId, ws));
      const readable = productRows.filter(
        (p) => p.groupId && subtree.has(p.groupId) && canReadProduct(access, p),
      );

      const summaries = await this.productAggregates(
        tx,
        ws,
        readable.map((p) => p.id),
      );

      // Keep product order consistent with listProducts (position, then name).
      const ordered = [...readable]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((p) => summaries.get(p.id)!);

      return {
        group: this.groupRecord(group, counts),
        subgroups: groupRows
          .filter((g) => g.parentId === id)
          .map((g) => this.groupRecord(g, counts)),
        products: ordered,
      };
    });
  }

  async listBlockingEdges(scope?: WorkspaceScope): Promise<BlockingEdge[]> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [rows, access, productById] = await Promise.all([
        tx
          .select({
            id: features.id,
            specId: features.specId,
            productId: features.productId,
          })
          .from(features)
          .where(eq(features.workspaceId, ws)),
        this.accessIn(tx, scope!),
        this.productVisibilityIn(tx, ws),
      ]);
      // Same filter listFeatures applies to the counts it derives from these
      // edges: an edge is only visible when both of its ends are.
      const specById = new Map(
        rows
          .filter((row) => canReadProductId(access, productById, row.productId))
          .map((row) => [row.id, row.specId]),
      );
      const links = await tx
        .select({
          fromFeatureId: featureLinks.fromFeatureId,
          toFeatureId: featureLinks.toFeatureId,
        })
        .from(featureLinks)
        .where(
          and(
            eq(featureLinks.workspaceId, ws),
            eq(featureLinks.type, "blocks"),
          ),
        );
      const out: BlockingEdge[] = [];
      for (const link of links) {
        const blocker = specById.get(link.fromFeatureId);
        const blocked = specById.get(link.toFeatureId);
        if (blocker && blocked) {
          out.push({ blockerSpecId: blocker, blockedSpecId: blocked });
        }
      }
      return out;
    });
  }

  /**
   * Per-product item totals, status breakdown, and per-release progress, all
   * derived at read time from one grouped scan (no denormalized counts).
   *
   * The roll-up shape both dashboards share: the caller decides which products
   * are in scope (a group's subtree, or the whole workspace) and this decides
   * what a count means, so the group and leadership dashboards cannot drift.
   */
  private async productAggregates(
    tx: Tx,
    ws: string,
    productIds: string[],
  ): Promise<Map<string, GroupProductSummary>> {
    const summaries = new Map<string, GroupProductSummary>(
      productIds.map((id) => [
        id,
        { productId: id, itemCount: 0, statusCounts: {}, releases: [] },
      ]),
    );
    if (productIds.length === 0) return summaries;

    const [rows, done] = await Promise.all([
      tx
        .select({
          productId: features.productId,
          status: features.status,
          releaseId: features.releaseId,
          n: count(),
        })
        .from(features)
        .where(
          and(
            eq(features.workspaceId, ws),
            inArray(features.productId, productIds),
          ),
        )
        .groupBy(features.productId, features.status, features.releaseId),
      doneStatusesIn(tx, ws),
    ]);

    const releaseTotals = new Map<
      string,
      Map<string, { total: number; done: number }>
    >();
    for (const row of rows) {
      if (!row.productId) continue;
      const summary = summaries.get(row.productId);
      if (!summary) continue;
      const n = Number(row.n);
      summary.itemCount += n;
      summary.statusCounts[row.status] =
        (summary.statusCounts[row.status] ?? 0) + n;
      if (row.releaseId) {
        const byRelease =
          releaseTotals.get(row.productId) ??
          new Map<string, { total: number; done: number }>();
        releaseTotals.set(row.productId, byRelease);
        const entry = byRelease.get(row.releaseId) ?? { total: 0, done: 0 };
        entry.total += n;
        if (done.isDone(row.status, row.productId)) entry.done += n;
        byRelease.set(row.releaseId, entry);
      }
    }
    for (const [productId, byRelease] of releaseTotals) {
      const summary = summaries.get(productId);
      if (!summary) continue;
      summary.releases = [...byRelease.entries()].map(
        ([releaseId, { total, done }]) => ({ releaseId, total, done }),
      );
    }
    return summaries;
  }

  async getWorkspaceSummary(
    options: WorkspaceSummaryOptions,
    scope?: WorkspaceScope,
  ): Promise<WorkspaceSummary> {
    return this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      const [productRows, access] = await Promise.all([
        tx.select().from(products).where(eq(products.workspaceId, ws)),
        this.accessIn(tx, scope!),
      ]);
      // Same visibility rule as listProducts and the group roll-up: a product
      // the viewer cannot read contributes nothing, so no total can betray that
      // it exists.
      const readable = productRows.filter((p) => canReadProduct(access, p));
      const readableIds = readable.map((p) => p.id);

      const summaries = await this.productAggregates(tx, ws, readableIds);
      const ordered = [...readable]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((p) => summaries.get(p.id)!);

      return {
        products: ordered,
        signals: await this.workspaceSignals(tx, ws, readableIds, options),
      };
    });
  }

  /**
   * The three escalation signals, each as a true count plus a capped sample.
   *
   * Every query is restricted to `readableIds`, so an unreadable product cannot
   * leak an item's title through a signal, and each excludes archived items and
   * anything already done (a blocker on finished work is history, not a signal).
   */
  private async workspaceSignals(
    tx: Tx,
    ws: string,
    readableIds: string[],
    options: WorkspaceSummaryOptions,
  ): Promise<WorkspaceSignals> {
    const empty: WorkspaceSignals = {
      blocked: [],
      overdue: [],
      stale: [],
      counts: { blocked: 0, overdue: 0, stale: 0 },
    };
    if (readableIds.length === 0) return empty;

    const inScope = and(
      eq(features.workspaceId, ws),
      inArray(features.productId, readableIds),
      ne(features.status, "archived"),
      ne(features.status, "done"),
    );
    const select = {
      specId: features.specId,
      title: features.title,
      level: features.level,
      status: features.status,
      productId: features.productId,
      releaseId: features.releaseId,
      updatedAt: features.updatedAt,
    };

    const staleDays = options.staleDays ?? 14;
    const todayMs = Date.parse(`${options.today}T00:00:00Z`);
    // A malformed `today` would silently make everything (or nothing) overdue,
    // so refuse rather than reporting a number nobody can trust.
    if (Number.isNaN(todayMs)) {
      throw new Error(`getWorkspaceSummary: invalid today "${options.today}"`);
    }
    const staleBefore = new Date(todayMs - staleDays * 24 * 60 * 60 * 1000);

    const [blockedRows, overdueRows, staleRows] = await Promise.all([
      // Blocked: an inbound `blocks` edge. The edge is stored one way only
      // (from blocks to), so "blocked" is the to_feature_id side.
      tx
        .selectDistinct(select)
        .from(features)
        .innerJoin(featureLinks, eq(featureLinks.toFeatureId, features.id))
        .where(and(inScope, eq(featureLinks.type, "blocks")))
        .orderBy(asc(features.updatedAt)),
      // Past target: the release it ships in was due before today.
      tx
        .select(select)
        .from(features)
        .innerJoin(releases, eq(releases.id, features.releaseId))
        .where(
          and(
            inScope,
            ne(releases.status, "shipped"),
            lt(releases.targetDate, options.today),
          ),
        )
        .orderBy(asc(releases.targetDate)),
      // Stale: in flight by the caller's definition, untouched for staleDays.
      options.activeStatuses.length === 0
        ? Promise.resolve([])
        : tx
            .select(select)
            .from(features)
            .where(
              and(
                inScope,
                inArray(features.status, options.activeStatuses),
                lt(features.updatedAt, staleBefore),
              ),
            )
            .orderBy(asc(features.updatedAt)),
    ]);

    const item = (row: (typeof blockedRows)[number]): SignalItem => ({
      specId: row.specId,
      title: row.title,
      level: row.level,
      status: row.status,
      productId: row.productId,
      releaseId: row.releaseId,
    });
    const withAge = (row: (typeof staleRows)[number]): SignalItem => ({
      ...item(row),
      staleDays: Math.floor(
        (todayMs - row.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
      ),
    });

    return {
      blocked: blockedRows.slice(0, SIGNAL_SAMPLE_LIMIT).map(item),
      overdue: overdueRows.slice(0, SIGNAL_SAMPLE_LIMIT).map(item),
      stale: staleRows.slice(0, SIGNAL_SAMPLE_LIMIT).map(withAge),
      counts: {
        blocked: blockedRows.length,
        overdue: overdueRows.length,
        stale: staleRows.length,
      },
    };
  }

  async listProductMembers(
    productId: string,
    scope?: WorkspaceScope,
  ): Promise<ProductMemberRecord[]> {
    return this.scoped(scope, async (tx) => {
      const rows = await tx
        .select({
          userId: productMembers.userId,
          name: users.name,
          email: users.email,
          role: productMembers.role,
        })
        .from(productMembers)
        .innerJoin(users, eq(users.id, productMembers.userId))
        .where(
          and(
            eq(productMembers.workspaceId, scope!.workspaceId),
            eq(productMembers.productId, productId),
          ),
        )
        .orderBy(asc(users.name));
      return rows;
    });
  }

  async setProductMember(
    productId: string,
    input: ProductMemberInput,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      const ws = scope!.workspaceId;
      await this.requireProductId(tx, ws, productId);
      await this.assertWorkspaceMember(tx, ws, input.userId);
      await tx
        .insert(productMembers)
        .values({
          workspaceId: ws,
          productId,
          userId: input.userId,
          role: input.role,
        })
        .onConflictDoUpdate({
          target: [productMembers.productId, productMembers.userId],
          set: { role: input.role },
        });
    });
  }

  async removeProductMember(
    productId: string,
    userId: string,
    scope?: WorkspaceScope,
  ): Promise<void> {
    await this.scoped(scope, async (tx) => {
      await tx
        .delete(productMembers)
        .where(
          and(
            eq(productMembers.workspaceId, scope!.workspaceId),
            eq(productMembers.productId, productId),
            eq(productMembers.userId, userId),
          ),
        );
    });
  }
}

export { specIndex };
