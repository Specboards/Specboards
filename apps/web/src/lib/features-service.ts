import {
  canTransition,
  isForwardTransition,
  shortestTransitionPath,
  transitionErrorMessage,
  isPropertyEntity,
  isPropertyType,
  isValidParentLevel,
  propertyKeyFromLabel,
  isGoalStatus,
  isMetricKind,
  validateCycleDates,
  validateCycleScheduleInput,
  validateGoalPeriod,
  validateKeyResult,
  GOAL_STATUSES,
  METRIC_KINDS,
  type GoalStatus,
  type MetricKind,
  type PropertyDef,
} from "@specboards/core";

import { getDb } from "@/lib/db";
import { RICE_IMPACT_VALUES } from "@/lib/feature-helpers";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { deleteSpecFile } from "@/lib/spec-content";
import { notifyOutbox } from "@/lib/webhooks/events";
import {
  getStore,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureStore,
  type OutboxEmit,
  type WorkspaceScope,
  type WorkspaceLevel,
} from "@/lib/store";
import {
  RELATION_DIRECTIONS,
  RELEASE_NOTES_MODES,
  RELEASE_STATUSES,
  RelationError,
  type CommentInput,
  type CommentRecord,
  type NotificationList,
  type CreatableRelationDirection,
  type CreateFeatureInput,
  type DetailTemplate,
  type DetailTemplateInput,
  type DetailTemplatePatch,
  type FeatureRelation,
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type LevelUpdate,
  type PropertyInput,
  type PropertyPatch,
  type RelationInput,
  type GoalContribution,
  type GoalInput,
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
  type ReleaseInput,
  type ReleaseNotesMode,
  type ReleasePatch,
  type ReleaseRecord,
  type ReleaseStatus,
  type StageGate,
  type StageGateInput,
  type TransitionMode,
  type StatusStageInput,
  type WorkspaceStatus,
} from "@/lib/store/types";
import type { IdeaStage } from "@specboards/core";

/**
 * Domain operations behind the public /api/v1 surface. Route handlers stay
 * thin; validation and store access live here.
 */

export class FeatureNotFoundError extends Error {
  constructor(specId: string) {
    super(`Unknown feature: ${specId}`);
  }
}

export class InvalidPatchError extends Error {}

/** Parse and validate an untrusted PATCH body into a FeaturePatch. */
export function parseFeaturePatch(body: unknown): FeaturePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: FeaturePatch = {};

  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      throw new InvalidPatchError("title must be a non-empty string.");
    }
    patch.title = raw.title.trim();
  }
  if ("status" in raw) {
    if (typeof raw.status !== "string" || raw.status === "") {
      throw new InvalidPatchError("status must be a non-empty string.");
    }
    patch.status = raw.status;
  }
  if ("rank" in raw) {
    if (raw.rank !== null && (typeof raw.rank !== "string" || raw.rank === "")) {
      throw new InvalidPatchError("rank must be a non-empty string or null.");
    }
    patch.rank = raw.rank as string | null;
  }
  if ("releaseId" in raw) {
    if (raw.releaseId !== null && !isUuid(raw.releaseId)) {
      throw new InvalidPatchError("releaseId must be a UUID or null.");
    }
    patch.releaseId = raw.releaseId as string | null;
  }
  if ("cycleId" in raw) {
    if (raw.cycleId !== null && !isUuid(raw.cycleId)) {
      throw new InvalidPatchError("cycleId must be a UUID or null.");
    }
    patch.cycleId = raw.cycleId as string | null;
  }
  if ("tags" in raw) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string")) {
      throw new InvalidPatchError("tags must be an array of strings.");
    }
    patch.tags = (raw.tags as string[]).map((t) => t.trim()).filter(Boolean);
  }
  if ("assigneeId" in raw) {
    if (raw.assigneeId !== null && !isUuid(raw.assigneeId)) {
      throw new InvalidPatchError("assigneeId must be a UUID or null.");
    }
    patch.assigneeId = raw.assigneeId as string | null;
  }
  if ("customFields" in raw) {
    patch.customFields = parseCustomFields(raw.customFields);
  }
  if ("riceReach" in raw) {
    patch.riceReach = parseRiceNumber(raw.riceReach, "riceReach", { min: 0 });
  }
  if ("riceImpact" in raw) {
    if (raw.riceImpact !== null && !RICE_IMPACT_VALUES.includes(raw.riceImpact as number)) {
      throw new InvalidPatchError(
        `riceImpact must be one of ${RICE_IMPACT_VALUES.join(", ")}, or null.`,
      );
    }
    patch.riceImpact = raw.riceImpact as number | null;
  }
  if ("riceConfidence" in raw) {
    const c = parseRiceNumber(raw.riceConfidence, "riceConfidence", { min: 0, max: 100 });
    if (c !== null && !Number.isInteger(c)) {
      throw new InvalidPatchError("riceConfidence must be a whole number 0-100, or null.");
    }
    patch.riceConfidence = c;
  }
  if ("riceEffort" in raw) {
    patch.riceEffort = parseRiceNumber(raw.riceEffort, "riceEffort", { exclusiveMin: 0 });
  }
  if ("parentSpecId" in raw) {
    if (raw.parentSpecId !== null && !isUuid(raw.parentSpecId)) {
      throw new InvalidPatchError("parentSpecId must be a UUID or null.");
    }
    patch.parentSpecId = raw.parentSpecId as string | null;
  }
  if ("details" in raw) {
    if (raw.details !== null && typeof raw.details !== "string") {
      throw new InvalidPatchError("details must be a string or null.");
    }
    if (typeof raw.details === "string" && raw.details.length > 100_000) {
      throw new InvalidPatchError("details is too long.");
    }
    patch.details = raw.details as string | null;
  }

  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: title, status, rank, tags, releaseId, cycleId, assigneeId, customFields, parentSpecId, details.",
    );
  }
  return patch;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Validate a RICE numeric input: a finite number within bounds, or null. */
function parseRiceNumber(
  value: unknown,
  field: string,
  bounds: { min?: number; max?: number; exclusiveMin?: number },
): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidPatchError(`${field} must be a number or null.`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new InvalidPatchError(`${field} must be at least ${bounds.min}.`);
  }
  if (bounds.exclusiveMin !== undefined && value <= bounds.exclusiveMin) {
    throw new InvalidPatchError(`${field} must be greater than ${bounds.exclusiveMin}.`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new InvalidPatchError(`${field} must be at most ${bounds.max}.`);
  }
  return value;
}

/** Validate an untrusted custom-fields map: a flat object of scalar/string[] values. */
function parseCustomFields(value: unknown): Record<string, CustomFieldValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidPatchError("customFields must be a JSON object.");
  }
  const out: Record<string, CustomFieldValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      raw === null ||
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      (Array.isArray(raw) && raw.every((v) => typeof v === "string"))
    ) {
      out[key] = raw as CustomFieldValue;
    } else {
      throw new InvalidPatchError(
        `customFields.${key} must be a string, number, boolean, string[], or null.`,
      );
    }
  }
  return out;
}

/** Whether `value` is a real calendar date in `YYYY-MM-DD` form. */
function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Enforce declared custom-property types on the values being written. Only
 * `date` is checked today (it must be a real ISO `YYYY-MM-DD`), so a date field
 * is trustworthy to sort and, later, to plot on a timeline. Values for unknown
 * keys or untyped-here properties pass through (structural checks already ran
 * in {@link parseCustomFields}). A `null` clears a field and is always allowed.
 */
export function assertCustomFieldTypes(
  customFields: Record<string, CustomFieldValue>,
  properties: PropertyDef[],
): void {
  const typeByKey = new Map(properties.map((p) => [p.key, p.type]));
  for (const [key, value] of Object.entries(customFields)) {
    if (value === null) continue;
    if (typeByKey.get(key) === "date") {
      if (typeof value !== "string" || !isIsoDate(value)) {
        throw new InvalidPatchError(
          `customFields.${key} must be a date in YYYY-MM-DD format.`,
        );
      }
    }
  }
}

/** Options that change how a patch is applied, rather than what it sets. */
export interface PatchOptions {
  /**
   * Walk the item through the shortest legal chain of intermediate stages when
   * the requested status isn't reachable in one move. Without this, a strict
   * workflow rejects the jump and the caller has to issue one call per stage,
   * which is what agents and integrations kept having to do.
   *
   * Each hop is applied as an ordinary single-step move, so stage gates are
   * enforced and an `item.status_changed` event is emitted per hop: the audit
   * trail records the stages the item really passed through. The walk is not
   * atomic (each hop is its own transaction); if a gate blocks a later hop the
   * item stops there and the error says where it got to.
   */
  advance?: boolean;
}

/**
 * Apply a validated patch, enforcing the status workflow. With
 * {@link PatchOptions.advance} a multi-stage status move is walked one legal
 * hop at a time instead of rejected.
 */
export async function patchFeature(
  specId: string,
  patch: FeaturePatch,
  scope?: WorkspaceScope,
  options?: PatchOptions,
): Promise<FeatureDetail> {
  if (patch.status === undefined || !options?.advance) {
    return applyFeaturePatch(specId, patch, scope);
  }

  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);
  const workflow = await resolveWorkflowFor(scope ?? null);
  const path = shortestTransitionPath(feature.status, patch.status, workflow);
  if (path === null) {
    throw new InvalidPatchError(
      transitionErrorMessage(feature.status, patch.status, workflow),
    );
  }
  // A single hop (or none) is an ordinary patch; no need to fan it out.
  if (path.length <= 1) return applyFeaturePatch(specId, patch, scope);

  let result = feature;
  for (const [i, hop] of path.entries()) {
    // The rest of the patch rides along with the final hop, so a caller can
    // advance and set other fields in one request.
    const hopPatch =
      i === path.length - 1 ? { ...patch, status: hop } : { status: hop };
    try {
      result = await applyFeaturePatch(specId, hopPatch, scope);
    } catch (err) {
      if (err instanceof InvalidPatchError && i > 0) {
        throw new InvalidPatchError(
          `Advanced ${feature.status} -> ${path[i - 1]} on the way to ` +
            `${patch.status}, then stopped: ${err.message}`,
        );
      }
      throw err;
    }
  }
  return result;
}

/** One validated single-step patch: the workflow rules apply as written. */
async function applyFeaturePatch(
  specId: string,
  patch: FeaturePatch,
  scope?: WorkspaceScope,
): Promise<FeatureDetail> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);

  // Type-check custom-field values against their property definitions (date
  // fields must be real ISO dates). Skipped when no custom fields are being
  // written, so the common patch avoids the extra property lookup.
  if (patch.customFields && Object.keys(patch.customFields).length > 0) {
    const properties = await store.listProperties(scope, "item");
    assertCustomFieldTypes(patch.customFields, properties);
  }

  if (patch.title !== undefined && !feature.isDbNative) {
    throw new InvalidPatchError(
      "Spec-backed item titles come from the spec. Edit the title in git.",
    );
  }

  if (patch.status !== undefined) {
    const workflow = await resolveWorkflowFor(scope ?? null);
    if (!canTransition(feature.status, patch.status, workflow)) {
      throw new InvalidPatchError(transitionErrorMessage(feature.status, patch.status, workflow));
    }
    // Stage gates block only forward moves; pulling back or archiving is free.
    if (isForwardTransition(feature.status, patch.status, workflow)) {
      await assertGatesSatisfied(
        specId,
        feature.status,
        patch.status,
        workflow,
        scope,
      );
    }
  }

  if (patch.parentSpecId) {
    await assertNoParentCycle(specId, patch.parentSpecId, scope);
    // The parent must sit exactly one level above this item.
    const parent = await store.getFeature(patch.parentSpecId, scope);
    if (!parent) {
      throw new InvalidPatchError(`Unknown parent feature: ${patch.parentSpecId}`);
    }
    const levels = await store.listLevels(scope);
    if (!isValidParentLevel(feature.level, parent.level, levels)) {
      throw new InvalidPatchError(
        `A ${feature.level} can't sit under a ${parent.level}.`,
      );
    }
  }

  // Record a status-change event in the SAME transaction as the update (via the
  // store's outbox), so a crash can't leave the change persisted but the event
  // lost. The relay fans it out to webhooks afterward.
  let emit: OutboxEmit | undefined;
  if (patch.status !== undefined && patch.status !== feature.status) {
    emit = {
      type: "item.status_changed",
      productId: feature.productId,
      data: {
        specId: feature.specId,
        title: patch.title ?? feature.title,
        level: feature.level,
        from: feature.status,
        to: patch.status,
      },
    };
  }

  await store.updateFeature(specId, patch, scope, emit);

  // Re-parenting away from an auto-created Feature grouping can leave it with
  // nothing in it. Sync keys a grouping by the spec's folder and `create_spec`
  // gives every spec its own folder, so the documented agent flow (create_spec,
  // then update_item(parentSpecId) to nest it under a real card) stranded a
  // same-named, empty grouping on the board every time. Clean it up here, at
  // the moment it is abandoned. The store refuses unless it is genuinely an
  // untouched, childless auto grouping.
  //
  // Best-effort: this is cleanup behind the user's write, so a failure must not
  // fail the patch that already committed.
  const previousParentSpecId = feature.parentSpecId;
  if (
    patch.parentSpecId !== undefined &&
    previousParentSpecId !== null &&
    previousParentSpecId !== patch.parentSpecId
  ) {
    try {
      await store.pruneAutoGrouping(previousParentSpecId, scope);
    } catch (err) {
      console.warn(
        `[features] pruning abandoned grouping ${previousParentSpecId} failed:`,
        err,
      );
    }
  }

  const updated = await store.getFeature(specId, scope);
  if (emit) notifyOutbox(); // nudge the relay so delivery isn't delayed a tick

  return updated ?? feature;
}

/** The fields a bulk edit may set directly. Tags are handled separately (add /
 * clear) so a mixed selection isn't clobbered by a single replacement; other
 * per-item concerns (title, rank, parent, details, customFields) are excluded. */
const BULK_PATCH_KEYS = ["status", "assigneeId", "releaseId", "cycleId"] as const;

/** Cap a single batch so one request can't fan out unbounded work. */
const BULK_MAX_ITEMS = 200;

/** Tag mutations applied per item as a merge (not a wholesale replace). */
export interface BulkTagOps {
  /** Tags to add to each item, deduped against its existing tags. */
  addTags?: string[];
  /** Remove every tag from each selected item. */
  clearTags?: boolean;
}

export interface BulkPatchRequest {
  specIds: string[];
  patch: FeaturePatch;
  tagOps: BulkTagOps;
}

/** Outcome for one item in a bulk edit. */
export interface BulkPatchItemResult {
  specId: string;
  ok: boolean;
  /** Failure reason when `ok` is false (e.g. an illegal status transition). */
  error?: string;
}

export interface BulkPatchResult {
  results: BulkPatchItemResult[];
  okCount: number;
  failCount: number;
}

/** Parse an untrusted bulk-PATCH body: `{ specIds, patch?, addTags?, clearTags? }`.
 * The direct patch is validated like a single edit then restricted to the
 * bulk-safe fields; tag ops are validated separately. At least one change must
 * be requested. */
export function parseBulkPatchRequest(body: unknown): BulkPatchRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.specIds) || raw.specIds.length === 0) {
    throw new InvalidPatchError("specIds must be a non-empty array.");
  }
  if (raw.specIds.some((s) => typeof s !== "string" || s === "")) {
    throw new InvalidPatchError("specIds must be non-empty strings.");
  }
  const specIds = [...new Set(raw.specIds as string[])];
  if (specIds.length > BULK_MAX_ITEMS) {
    throw new InvalidPatchError(
      `A bulk edit can target at most ${BULK_MAX_ITEMS} items.`,
    );
  }

  // The direct patch is optional (a request may be tag-only).
  let patch: FeaturePatch = {};
  const rawPatch = raw.patch;
  if (rawPatch !== undefined && !(typeof rawPatch === "object" && rawPatch !== null && Object.keys(rawPatch).length === 0)) {
    patch = parseFeaturePatch(rawPatch);
    const disallowed = Object.keys(patch).filter(
      (k) => !(BULK_PATCH_KEYS as readonly string[]).includes(k),
    );
    if (disallowed.length > 0) {
      throw new InvalidPatchError(
        `Bulk edits can only set ${BULK_PATCH_KEYS.join(", ")} (or add/clear tags); not ${disallowed.join(", ")}.`,
      );
    }
  }

  const tagOps: BulkTagOps = {};
  if ("addTags" in raw && raw.addTags !== undefined) {
    if (!Array.isArray(raw.addTags) || raw.addTags.some((t) => typeof t !== "string")) {
      throw new InvalidPatchError("addTags must be an array of strings.");
    }
    const cleaned = [...new Set((raw.addTags as string[]).map((t) => t.trim()).filter(Boolean))];
    if (cleaned.length > 0) tagOps.addTags = cleaned;
  }
  if (raw.clearTags === true) tagOps.clearTags = true;

  if (Object.keys(patch).length === 0 && !tagOps.addTags && !tagOps.clearTags) {
    throw new InvalidPatchError(
      "A bulk edit must change at least one of: status, assigneeId, releaseId, cycleId, addTags, clearTags.",
    );
  }
  if (tagOps.clearTags && tagOps.addTags) {
    throw new InvalidPatchError("clearTags and addTags can't be combined.");
  }
  return { specIds, patch, tagOps };
}

/**
 * Apply the same change to many items, each in its own transaction (via
 * {@link patchFeature}) so a rejection on one - an illegal status transition, an
 * unmet stage gate, a cross-product release - doesn't roll back the others.
 * Tag ops merge per item (add is deduped against existing tags; clear empties
 * them). Reuses every single-item guard and outbox emission, and returns a
 * per-item result so the caller can report exactly what changed.
 */
export async function bulkPatchFeatures(
  specIds: string[],
  patch: FeaturePatch,
  tagOps: BulkTagOps,
  scope?: WorkspaceScope,
): Promise<BulkPatchResult> {
  const store = await getStore();
  const results: BulkPatchItemResult[] = [];
  for (const specId of specIds) {
    try {
      const itemPatch: FeaturePatch = { ...patch };
      if (tagOps.clearTags) {
        itemPatch.tags = [];
      } else if (tagOps.addTags) {
        const feature = await store.getFeature(specId, scope);
        if (!feature) throw new FeatureNotFoundError(specId);
        itemPatch.tags = [...new Set([...feature.tags, ...tagOps.addTags])];
      }
      await patchFeature(specId, itemPatch, scope);
      results.push({ specId, ok: true });
    } catch (err) {
      if (
        err instanceof InvalidPatchError ||
        err instanceof FeatureNotFoundError ||
        err instanceof RelationError
      ) {
        results.push({ specId, ok: false, error: err.message });
      } else {
        throw err; // unexpected: let it surface rather than swallow it per item
      }
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { results, okCount, failCount: results.length - okCount };
}

/**
 * Enforce the exit-criteria stage gates for a forward move `from -> to`. Every
 * gate on every stage the item advances *past* (the source stage and any stages
 * skipped over, i.e. the half-open range [from, to)) must be checked off, or the
 * move is rejected. Checking the whole range, not just the source, stops a
 * multi-stage jump from bypassing an intermediate stage's checklist under open
 * (any-to-any) workflows.
 *
 * This is the single point where gate policy is applied for the web API, so
 * future rules (per-item-type bypass, admin "skip with reason") slot in here.
 * The MCP server enforces the same rule over its own DB path in `openGates`
 * (apps/mcp/src/server.ts); keep the two in sync until they share a store-backed
 * helper. No-op when no passed-over stage has gates.
 */
async function assertGatesSatisfied(
  specId: string,
  from: string,
  to: string,
  workflow: { statuses: readonly string[] },
  scope?: WorkspaceScope,
): Promise<void> {
  const fromIndex = workflow.statuses.indexOf(from);
  const toIndex = workflow.statuses.indexOf(to);
  // Stages advanced past: source up to (not including) the destination.
  const passed = new Set(workflow.statuses.slice(fromIndex, toIndex));
  const store = await getStore();
  const gates = (await store.listStageGates(scope)).filter((g) =>
    passed.has(g.stageKey),
  );
  if (gates.length === 0) return;
  const done = new Set(await store.listGateCompletions(specId, scope));
  const open = gates.filter((g) => !done.has(g.id));
  if (open.length === 0) return;
  const labels = open.map((g) => `"${g.label}"`).join(", ");
  throw new InvalidPatchError(
    `This item can't advance until its stage checklist is complete. Remaining: ${labels}.`,
  );
}

/**
 * Reject parenting `specId` under `parentSpecId` if it would form a cycle
 * (parent is the feature itself or one of its descendants). Walks up the
 * parent chain via the store, so it's store-agnostic.
 */
async function assertNoParentCycle(
  specId: string,
  parentSpecId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  if (parentSpecId === specId) {
    throw new InvalidPatchError("A feature cannot be its own parent.");
  }
  const store = await getStore();
  const seen = new Set<string>();
  let cur: string | null = parentSpecId;
  while (cur) {
    if (cur === specId) {
      throw new InvalidPatchError(
        "That parent would create a circular hierarchy.",
      );
    }
    if (seen.has(cur)) break; // pre-existing cycle guard; don't loop forever
    seen.add(cur);
    const node = await store.getFeature(cur, scope);
    if (!node) {
      throw new InvalidPatchError(`Unknown parent feature: ${parentSpecId}`);
    }
    cur = node.parentSpecId;
  }
}

/** Parse and validate an untrusted create-work-item body. */
export function parseCreateFeatureInput(body: unknown): CreateFeatureInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new InvalidPatchError("title is required.");
  }
  if (typeof raw.level !== "string" || raw.level.trim() === "") {
    throw new InvalidPatchError("level is required.");
  }
  const input: CreateFeatureInput = {
    title: raw.title.trim(),
    level: raw.level.trim(),
  };

  // productId is any non-empty product id (a UUID in the cloud DB; a stable key
  // like "default" in local file mode) or null. The store validates that the
  // product exists and is writable, so we only check the shape here. Mirrors the
  // release/idea parsers' leniency, and lets a product-scoped create work in
  // local mode where product ids aren't UUIDs.
  if ("productId" in raw && raw.productId !== null && raw.productId !== "") {
    if (typeof raw.productId !== "string") {
      throw new InvalidPatchError("productId must be a string or null.");
    }
    input.productId = raw.productId;
  }
  if ("parentSpecId" in raw && raw.parentSpecId !== null) {
    if (!isUuid(raw.parentSpecId)) {
      throw new InvalidPatchError("parentSpecId must be a UUID or null.");
    }
    input.parentSpecId = raw.parentSpecId;
  }
  if ("status" in raw) {
    if (typeof raw.status !== "string" || raw.status === "") {
      throw new InvalidPatchError("status must be a non-empty string.");
    }
    input.status = raw.status;
  }
  if ("assigneeId" in raw && raw.assigneeId !== null) {
    if (!isUuid(raw.assigneeId)) {
      throw new InvalidPatchError("assigneeId must be a UUID or null.");
    }
    input.assigneeId = raw.assigneeId;
  }
  if ("releaseId" in raw && raw.releaseId !== null) {
    if (!isUuid(raw.releaseId)) {
      throw new InvalidPatchError("releaseId must be a UUID or null.");
    }
    input.releaseId = raw.releaseId;
  }
  if ("cycleId" in raw && raw.cycleId !== null) {
    if (!isUuid(raw.cycleId)) {
      throw new InvalidPatchError("cycleId must be a UUID or null.");
    }
    input.cycleId = raw.cycleId;
  }
  if ("customFields" in raw && raw.customFields !== null) {
    input.customFields = parseCustomFields(raw.customFields);
  }
  if ("tags" in raw) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string")) {
      throw new InvalidPatchError("tags must be an array of strings.");
    }
    input.tags = (raw.tags as string[]).map((t) => t.trim()).filter(Boolean);
  }
  // `details: null` is preserved rather than dropped: an explicit null means
  // "create this one blank" and suppresses the level's detail template, while
  // omitting the key entirely (the column quick add) opts into it.
  if ("details" in raw) {
    if (raw.details === null) {
      input.details = null;
    } else {
      if (typeof raw.details !== "string") {
        throw new InvalidPatchError("details must be a string or null.");
      }
      if (raw.details.length > 100_000) {
        throw new InvalidPatchError("details is too long.");
      }
      input.details = raw.details;
    }
  }
  return input;
}

/** The workspace's hierarchy levels (top → leaf). */
export async function listLevels(
  scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  const store = await getStore();
  return store.listLevels(scope);
}

/** Parse and validate an untrusted hierarchy-config update body. */
export function parseLevelsUpdate(body: unknown): LevelUpdate[] {
  if (typeof body !== "object" || body === null) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = (body as { levels?: unknown }).levels;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InvalidPatchError("levels must be a non-empty array.");
  }
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new InvalidPatchError("Each level must be a JSON object.");
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.label !== "string" || e.label.trim() === "") {
      throw new InvalidPatchError("Each level needs a non-empty label.");
    }
    const out: LevelUpdate = { label: e.label.trim() };
    if (e.key !== undefined && e.key !== null && e.key !== "") {
      if (typeof e.key !== "string") {
        throw new InvalidPatchError("level.key must be a string.");
      }
      out.key = e.key;
    }
    return out;
  });
}

/** Replace the workspace's hierarchy levels; returns the resolved levels. */
export async function updateLevels(
  levels: LevelUpdate[],
  scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  const store = await getStore();
  return store.updateLevels(levels, scope);
}

/** Parse an untrusted per-level field-availability update body. */
export function parseLevelFieldsUpdate(
  body: unknown,
): Record<string, string[] | null> {
  if (typeof body !== "object" || body === null) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = (body as { fields?: unknown }).fields;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidPatchError(
      "fields must be an object keyed by level key.",
    );
  }
  const out: Record<string, string[] | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new InvalidPatchError(
        `fields.${key} must be null or an array of field keys.`,
      );
    }
    if (value.length > 100) {
      throw new InvalidPatchError(`fields.${key} lists too many fields.`);
    }
    out[key] = (value as string[]).map((v) => v.trim()).filter(Boolean);
  }
  return out;
}

/** Set per-level metadata field availability; returns the resolved levels. */
export async function updateLevelFields(
  fields: Record<string, string[] | null>,
  scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  const store = await getStore();
  return store.updateLevelFields(fields, scope);
}

/** The workspace's custom property definitions, ordered by position. */
export async function listProperties(
  scope?: WorkspaceScope,
): Promise<PropertyDef[]> {
  const store = await getStore();
  return store.listProperties(scope);
}

/** Parse and validate an untrusted property-create body. */
export function parsePropertyInput(body: unknown): PropertyInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.label !== "string" || raw.label.trim() === "") {
    throw new InvalidPatchError("label is required.");
  }
  if (!isPropertyType(raw.type)) {
    throw new InvalidPatchError(
      "type must be one of: text, number, select, multiselect, date, user.",
    );
  }
  const input: PropertyInput = { label: raw.label.trim(), type: raw.type };
  if ("entity" in raw) {
    if (!isPropertyEntity(raw.entity)) {
      throw new InvalidPatchError("entity must be one of: item, release.");
    }
    input.entity = raw.entity;
  }
  if ("options" in raw) input.options = parseStringArray(raw.options, "options");
  // Levels only apply to item properties; a release property is workspace-wide.
  if (input.entity !== "release" && "levels" in raw && raw.levels !== null) {
    input.levels = parseStringArray(raw.levels, "levels");
  }
  return input;
}

/** Parse and validate an untrusted property PATCH body. */
export function parsePropertyPatch(body: unknown): PropertyPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: PropertyPatch = {};
  if ("label" in raw) {
    if (typeof raw.label !== "string" || raw.label.trim() === "") {
      throw new InvalidPatchError("label must be a non-empty string.");
    }
    patch.label = raw.label.trim();
  }
  if ("options" in raw) patch.options = parseStringArray(raw.options, "options");
  if ("levels" in raw) {
    patch.levels =
      raw.levels === null ? null : parseStringArray(raw.levels, "levels");
  }
  if ("position" in raw) {
    if (typeof raw.position !== "number" || !Number.isInteger(raw.position)) {
      throw new InvalidPatchError("position must be an integer.");
    }
    patch.position = raw.position;
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: label, options, levels, position.",
    );
  }
  return patch;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new InvalidPatchError(`${field} must be an array of strings.`);
  }
  if (value.length > 100) {
    throw new InvalidPatchError(`${field} lists too many entries.`);
  }
  return (value as string[]).map((v) => v.trim()).filter(Boolean);
}

/** Create a custom property definition. */
export async function createProperty(
  input: PropertyInput,
  scope?: WorkspaceScope,
): Promise<PropertyDef> {
  const store = await getStore();
  return store.createProperty(input, scope);
}

/** Update a custom property definition. */
export async function updateProperty(
  id: string,
  patch: PropertyPatch,
  scope?: WorkspaceScope,
): Promise<PropertyDef> {
  const store = await getStore();
  return store.updateProperty(id, patch, scope);
}

/** Delete a custom property definition. */
export async function deleteProperty(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteProperty(id, scope);
}

/** The workspace's detail templates, ordered by name. */
export async function listDetailTemplates(
  scope?: WorkspaceScope,
): Promise<DetailTemplate[]> {
  const store = await getStore();
  return store.listDetailTemplates(scope);
}

/** Parse and validate an untrusted detail-template-create body. */
export function parseDetailTemplateInput(body: unknown): DetailTemplateInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidPatchError("name is required.");
  }
  const body_ = "body" in raw ? raw.body : "";
  if (typeof body_ !== "string") {
    throw new InvalidPatchError("body must be a string.");
  }
  if (body_.length > 100_000) {
    throw new InvalidPatchError("body is too long.");
  }
  return { name: raw.name.trim(), body: body_ };
}

/** Parse and validate an untrusted detail-template PATCH body. */
export function parseDetailTemplatePatch(body: unknown): DetailTemplatePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: DetailTemplatePatch = {};
  if ("name" in raw) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidPatchError("name must be a non-empty string.");
    }
    patch.name = raw.name.trim();
  }
  if ("body" in raw) {
    if (typeof raw.body !== "string") {
      throw new InvalidPatchError("body must be a string.");
    }
    if (raw.body.length > 100_000) {
      throw new InvalidPatchError("body is too long.");
    }
    patch.body = raw.body;
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError("Patch must set at least one of: name, body.");
  }
  return patch;
}

/** Create a detail template. */
export async function createDetailTemplate(
  input: DetailTemplateInput,
  scope?: WorkspaceScope,
): Promise<DetailTemplate> {
  const store = await getStore();
  return store.createDetailTemplate(input, scope);
}

/** Update a detail template. */
export async function updateDetailTemplate(
  id: string,
  patch: DetailTemplatePatch,
  scope?: WorkspaceScope,
): Promise<DetailTemplate> {
  const store = await getStore();
  return store.updateDetailTemplate(id, patch, scope);
}

/** Delete a detail template. */
export async function deleteDetailTemplate(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteDetailTemplate(id, scope);
}

/** Parse an untrusted per-level template-assignment body. */
export function parseLevelTemplatesUpdate(
  body: unknown,
): Record<string, string | null> {
  if (typeof body !== "object" || body === null) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = (body as { templates?: unknown }).templates;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidPatchError(
      "templates must be an object keyed by level key.",
    );
  }
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (!isUuid(value)) {
      throw new InvalidPatchError(`templates.${key} must be a UUID or null.`);
    }
    out[key] = value;
  }
  return out;
}

/** Assign default detail templates per level; returns the resolved levels. */
export async function updateLevelTemplates(
  templates: Record<string, string | null>,
  scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  const store = await getStore();
  return store.updateLevelTemplates(templates, scope);
}

/**
 * Keep a release's ship date on or after its start date by pulling the ship date
 * along when the start moves past it.
 *
 * A ship date earlier than the start is never a plan anyone means, so pushing a
 * release out should not also require re-picking its end: the invariant is
 * maintained here rather than rejected, which is what makes moving a release a
 * single edit. Only a patch that moves the start can trigger it, and only
 * against the ship date the release will actually have (the patch's own, or the
 * stored one it leaves alone), so a patch that sets both dates is respected as
 * written unless it is itself backwards.
 *
 * Lives in the service, not the form, so the REST API and the MCP tools hold the
 * same invariant the UI does. Dates are validated as `YYYY-MM-DD` upstream
 * (parseDate), which is why they compare as strings.
 */
export function clampReleaseTarget(
  patch: ReleasePatch,
  before: { targetDate: string | null } | null,
): ReleasePatch {
  const start = patch.startDate;
  if (!start) return patch;
  const target =
    patch.targetDate !== undefined ? patch.targetDate : before?.targetDate ?? null;
  if (!target || target >= start) return patch;
  return { ...patch, targetDate: start };
}

/** Create a release. */
export async function createRelease(
  input: ReleaseInput,
  scope?: WorkspaceScope,
): Promise<ReleaseRecord> {
  const store = await getStore();
  if (input.customFields && Object.keys(input.customFields).length > 0) {
    const properties = await store.listProperties(scope, "release");
    assertCustomFieldTypes(input.customFields, properties);
  }
  // Same invariant as an edit: a release cannot be born ending before it starts.
  const dates = clampReleaseTarget(
    { startDate: input.startDate, targetDate: input.targetDate },
    null,
  );
  return store.createRelease({ ...input, ...dates }, scope);
}

/** Update a release. */
export async function updateRelease(
  id: string,
  patch: ReleasePatch,
  scope?: WorkspaceScope,
): Promise<ReleaseRecord> {
  const store = await getStore();

  // Type-check release custom-field values against their release-scoped property
  // definitions (date fields must be real ISO dates), mirroring patchFeature.
  // Skipped when no custom fields are being written.
  if (patch.customFields && Object.keys(patch.customFields).length > 0) {
    const properties = await store.listProperties(scope, "release");
    assertCustomFieldTypes(patch.customFields, properties);
  }

  // Capture the prior status so we can detect the ship edge for the webhook.
  const before = (await store.listReleases(scope)).find((r) => r.id === id) ?? null;

  // A start moved past the ship date takes the ship date with it, so the two can
  // never end up in the wrong order. Applied before the webhook payload is built
  // so an event reports the dates the release actually lands on.
  const effective = clampReleaseTarget(patch, before);

  // Record release.shipped in the same transaction as the ship. A ship patch is
  // status-only in practice; apply any name/date overrides in the patch so the
  // payload reflects the post-update release (itemCount is unaffected by status).
  let emit: OutboxEmit | undefined;
  if (before && before.status !== "shipped" && effective.status === "shipped") {
    emit = {
      type: "release.shipped",
      // A product release scopes its event to that product; a portfolio
      // release (null productId) stays workspace-level.
      productId:
        effective.productId !== undefined ? effective.productId : before.productId,
      data: {
        releaseId: before.id,
        name: effective.name?.trim() || before.name,
        startDate:
          effective.startDate !== undefined
            ? effective.startDate
            : before.startDate,
        targetDate:
          effective.targetDate !== undefined
            ? effective.targetDate
            : before.targetDate,
        itemCount: before.itemCount,
      },
    };
  }

  const updated = await store.updateRelease(id, effective, scope, emit);
  if (emit) notifyOutbox();

  return updated;
}

/** Delete a release; its items are unscheduled, not deleted. */
export async function deleteRelease(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteRelease(id, scope);
}

/** The workspace's releases, dated first, undated last. */
export async function listReleases(
  scope?: WorkspaceScope,
): Promise<ReleaseRecord[]> {
  const store = await getStore();
  return store.listReleases(scope);
}

/** Validate and normalize a create-comment request body. */
export function parseCommentInput(body: unknown): CommentInput {
  if (typeof body !== "object" || body === null) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.body !== "string" || !b.body.trim()) {
    throw new InvalidPatchError("A non-empty comment body is required.");
  }
  const input: CommentInput = { body: b.body };
  if (b.mentionedUserIds !== undefined) {
    if (
      !Array.isArray(b.mentionedUserIds) ||
      b.mentionedUserIds.some((id) => typeof id !== "string")
    ) {
      throw new InvalidPatchError(
        "mentionedUserIds must be an array of user ids.",
      );
    }
    input.mentionedUserIds = b.mentionedUserIds as string[];
  }
  return input;
}

/** Comments on a feature (by stable specId), oldest first. */
export async function listComments(
  specId: string,
  scope?: WorkspaceScope,
): Promise<CommentRecord[]> {
  const store = await getStore();
  return store.listComments(specId, scope);
}

/** Add a comment to a feature (by stable specId), authored by the caller. */
export async function createComment(
  specId: string,
  input: CommentInput,
  scope?: WorkspaceScope,
): Promise<CommentRecord> {
  const store = await getStore();
  const comment = await store.createComment(specId, input, scope);
  // A comment with mentions writes a `comment.mentioned` outbox event; nudge the
  // relay so any delivery channels fire promptly (no-op when nothing was queued).
  if (input.mentionedUserIds && input.mentionedUserIds.length > 0) notifyOutbox();
  return comment;
}

/** Delete a comment; author or workspace owner only. */
export async function deleteComment(
  commentId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteComment(commentId, scope);
}

/** The caller's notifications plus their unread total. */
export async function listNotifications(
  scope?: WorkspaceScope,
): Promise<NotificationList> {
  const store = await getStore();
  return store.listNotifications(scope);
}

/** Mark one of the caller's notifications read. */
export async function markNotificationRead(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.markNotificationRead(id, scope);
}

/** Mark all of the caller's notifications read. */
export async function markAllNotificationsRead(
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.markAllNotificationsRead(scope);
}

/** The workspace's workflow stages, or `[]` when using the built-in default. */
export async function listStatuses(
  scope?: WorkspaceScope,
): Promise<WorkspaceStatus[]> {
  const store = await getStore();
  return store.listStatuses(scope);
}

/** How freely items may move between stages in this workspace. */
export async function getTransitionMode(
  scope?: WorkspaceScope,
): Promise<TransitionMode> {
  const store = await getStore();
  return store.getTransitionMode(scope);
}

/** Set the workspace's transition mode. Callers gate this to admins. */
export async function setTransitionMode(
  mode: TransitionMode,
  scope?: WorkspaceScope,
): Promise<TransitionMode> {
  const store = await getStore();
  return store.setTransitionMode(mode, scope);
}

/** Replace the workspace's workflow stages. */
export async function replaceStatuses(
  stages: StatusStageInput[],
  scope?: WorkspaceScope,
): Promise<WorkspaceStatus[]> {
  const store = await getStore();
  return store.replaceStatuses(stages, scope);
}

/**
 * Parse and validate an untrusted workflow-replacement body: `{ statuses:
 * [{ key?, label }] }`. Requires at least two stages, each with a non-empty
 * label. A caller-supplied `key` is honored when it's a valid, unique slug (so
 * a stage's key stays stable across a rename); otherwise a key is derived from
 * the label. `archived` is reserved for the system status.
 */
export function parseStatusStages(body: unknown): StatusStageInput[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = (body as { statuses?: unknown }).statuses;
  if (!Array.isArray(raw)) {
    throw new InvalidPatchError("statuses must be an array.");
  }
  if (raw.length < 2 || raw.length > 30) {
    throw new InvalidPatchError("A workflow needs between 2 and 30 stages.");
  }
  const taken = new Set<string>();
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new InvalidPatchError("Each stage must be an object.");
    }
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === "string" ? e.label.trim() : "";
    if (!label) throw new InvalidPatchError("Each stage needs a label.");
    const provided =
      typeof e.key === "string" && /^[a-z0-9_]+$/.test(e.key) ? e.key : null;
    let key =
      provided && provided !== "archived" && !taken.has(provided)
        ? provided
        : propertyKeyFromLabel(label, taken);
    if (key === "archived") key = propertyKeyFromLabel(`${label}_stage`, taken);
    taken.add(key);
    return { key, label };
  });
}

/** The workspace's stage gates (checklist items per stage). */
export async function listStageGates(
  scope?: WorkspaceScope,
): Promise<StageGate[]> {
  const store = await getStore();
  return store.listStageGates(scope);
}

/** Replace the workspace's stage gates wholesale (admin action). */
export async function replaceStageGates(
  gates: StageGateInput[],
  scope?: WorkspaceScope,
): Promise<StageGate[]> {
  const store = await getStore();
  return store.replaceStageGates(gates, scope);
}

/**
 * Parse and validate an untrusted stage-gates replacement body: `{ gates:
 * [{ stageKey, label }] }`. Each entry needs a non-empty `stageKey` and a
 * non-empty `label`. Order within a stage is preserved (it becomes the
 * checklist position). An empty array clears all gates.
 */
export function parseStageGates(body: unknown): StageGateInput[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = (body as { gates?: unknown }).gates;
  if (!Array.isArray(raw)) {
    throw new InvalidPatchError("gates must be an array.");
  }
  if (raw.length > 200) {
    throw new InvalidPatchError("Too many stage gates (max 200).");
  }
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new InvalidPatchError("Each gate must be an object.");
    }
    const e = entry as Record<string, unknown>;
    const stageKey = typeof e.stageKey === "string" ? e.stageKey.trim() : "";
    if (!stageKey) throw new InvalidPatchError("Each gate needs a stageKey.");
    const label = typeof e.label === "string" ? e.label.trim() : "";
    if (!label) throw new InvalidPatchError("Each gate needs a label.");
    if (label.length > 200) {
      throw new InvalidPatchError("A gate label is too long (max 200 chars).");
    }
    const gate: StageGateInput = { stageKey, label };
    if (typeof e.id === "string" && e.id) gate.id = e.id;
    return gate;
  });
}

/** The gate ids checked off for one feature. */
export async function listGateCompletions(
  specId: string,
  scope?: WorkspaceScope,
): Promise<string[]> {
  const store = await getStore();
  return store.listGateCompletions(specId, scope);
}

/** Mark a gate complete/incomplete for a feature. Returns the new set. */
export async function setGateCompletion(
  specId: string,
  gateId: string,
  completed: boolean,
  scope?: WorkspaceScope,
): Promise<string[]> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);
  await store.setGateCompletion(specId, gateId, completed, scope);
  return store.listGateCompletions(specId, scope);
}

/** Parse and validate an untrusted release-create body. */
export function parseReleaseInput(body: unknown): ReleaseInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidPatchError("name is required.");
  }
  const input: ReleaseInput = { name: raw.name.trim() };
  if ("productId" in raw) input.productId = parseProductId(raw.productId);
  if ("status" in raw) input.status = parseReleaseStatus(raw.status);
  if ("startDate" in raw) input.startDate = parseDate(raw.startDate, "startDate");
  if ("targetDate" in raw) input.targetDate = parseDate(raw.targetDate, "targetDate");
  if ("notes" in raw) input.notes = parseReleaseNotes(raw.notes);
  if ("releaseNotesMode" in raw)
    input.releaseNotesMode = parseReleaseNotesMode(raw.releaseNotesMode);
  if ("releaseNotesBody" in raw)
    input.releaseNotesBody = parseReleaseNotesBody(raw.releaseNotesBody);
  if ("releaseNotesUrl" in raw)
    input.releaseNotesUrl = parseReleaseNotesUrl(raw.releaseNotesUrl);
  if ("customFields" in raw)
    input.customFields = parseCustomFields(raw.customFields);
  return input;
}

/** Parse and validate an untrusted release PATCH body. */
export function parseReleasePatch(body: unknown): ReleasePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: ReleasePatch = {};
  if ("name" in raw) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidPatchError("name must be a non-empty string.");
    }
    patch.name = raw.name.trim();
  }
  if ("productId" in raw) patch.productId = parseProductId(raw.productId);
  if ("status" in raw) patch.status = parseReleaseStatus(raw.status);
  if ("startDate" in raw) patch.startDate = parseDate(raw.startDate, "startDate");
  if ("targetDate" in raw) patch.targetDate = parseDate(raw.targetDate, "targetDate");
  if ("notes" in raw) patch.notes = parseReleaseNotes(raw.notes);
  if ("releaseNotesMode" in raw)
    patch.releaseNotesMode = parseReleaseNotesMode(raw.releaseNotesMode);
  if ("releaseNotesBody" in raw)
    patch.releaseNotesBody = parseReleaseNotesBody(raw.releaseNotesBody);
  if ("releaseNotesUrl" in raw)
    patch.releaseNotesUrl = parseReleaseNotesUrl(raw.releaseNotesUrl);
  if ("customFields" in raw)
    patch.customFields = parseCustomFields(raw.customFields);
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: name, productId, status, " +
        "startDate, targetDate, notes, releaseNotesMode, releaseNotesBody, " +
        "releaseNotesUrl, customFields.",
    );
  }
  return patch;
}

// ── Cycles ────────────────────────────────────────────────────────────────
// Thin service wrappers, mirroring the release ones. Cycles carry no derived
// invariant of their own the way releases do (clampReleaseTarget): the
// start/end ordering is enforced by validateCycleDates in core, so both stores
// and both parsers reject the same thing with the same wording.

export async function listCycles(
  scope?: WorkspaceScope,
): Promise<CycleRecord[]> {
  const store = await getStore();
  return store.listCycles(scope);
}

export async function createCycle(
  input: CycleInput,
  scope?: WorkspaceScope,
): Promise<CycleRecord> {
  const store = await getStore();
  return store.createCycle(input, scope);
}

export async function updateCycle(
  id: string,
  patch: CyclePatch,
  scope?: WorkspaceScope,
): Promise<CycleRecord> {
  const store = await getStore();
  return store.updateCycle(id, patch, scope);
}

export async function deleteCycle(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteCycle(id, scope);
}

export async function rolloverCycle(
  fromId: string,
  toId: string,
  scope?: WorkspaceScope,
): Promise<CycleRolloverResult> {
  const store = await getStore();
  return store.rolloverCycle(fromId, toId, scope);
}

export async function generateCycles(
  input: CycleGenerateInput,
  scope?: WorkspaceScope,
): Promise<CycleRecord[]> {
  const store = await getStore();
  return store.generateCycles(input, scope);
}

/**
 * Parse and validate an untrusted generate-schedule POST body. The date and
 * naming rules themselves live in core's `validateCycleScheduleInput`, which
 * the store applies again, so this only has to establish the shape.
 */
export function parseCycleGenerateInput(body: unknown): CycleGenerateInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const startDate = parseDate(raw.startDate, "startDate");
  const endDate = parseDate(raw.endDate, "endDate");
  if (!startDate || !endDate) {
    throw new InvalidPatchError("startDate and endDate are required.");
  }
  if (typeof raw.lengthDays !== "number") {
    throw new InvalidPatchError("lengthDays must be a number of days.");
  }
  if (typeof raw.nameTemplate !== "string" || raw.nameTemplate.trim() === "") {
    throw new InvalidPatchError("nameTemplate is required.");
  }
  // Absent means "start at one", which is what a first run wants.
  const startNumber = "startNumber" in raw ? raw.startNumber : 1;
  if (typeof startNumber !== "number") {
    throw new InvalidPatchError("startNumber must be a number.");
  }
  const input: CycleGenerateInput = {
    startDate,
    endDate,
    lengthDays: raw.lengthDays,
    nameTemplate: raw.nameTemplate.trim(),
    startNumber,
  };
  const error = validateCycleScheduleInput(input);
  if (error) throw new InvalidPatchError(error);
  if ("productId" in raw) input.productId = parseProductId(raw.productId);
  if ("notes" in raw) input.notes = parseReleaseNotes(raw.notes);
  return input;
}

/** Parse and validate an untrusted cycle POST body. */
export function parseCycleInput(body: unknown): CycleInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidPatchError("name is required.");
  }
  const startDate = parseDate(raw.startDate, "startDate");
  const endDate = parseDate(raw.endDate, "endDate");
  if (!startDate || !endDate) {
    throw new InvalidPatchError("startDate and endDate are required.");
  }
  const dateError = validateCycleDates(startDate, endDate);
  if (dateError) throw new InvalidPatchError(dateError);
  const input: CycleInput = { name: raw.name.trim(), startDate, endDate };
  if ("productId" in raw) input.productId = parseProductId(raw.productId);
  if ("notes" in raw) input.notes = parseReleaseNotes(raw.notes);
  return input;
}

/** Parse and validate an untrusted cycle PATCH body. */
export function parseCyclePatch(body: unknown): CyclePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: CyclePatch = {};
  if ("name" in raw) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidPatchError("name must be a non-empty string.");
    }
    patch.name = raw.name.trim();
  }
  if ("productId" in raw) patch.productId = parseProductId(raw.productId);
  if ("startDate" in raw) {
    const value = parseDate(raw.startDate, "startDate");
    if (!value) throw new InvalidPatchError("startDate cannot be cleared.");
    patch.startDate = value;
  }
  if ("endDate" in raw) {
    const value = parseDate(raw.endDate, "endDate");
    if (!value) throw new InvalidPatchError("endDate cannot be cleared.");
    patch.endDate = value;
  }
  if ("notes" in raw) patch.notes = parseReleaseNotes(raw.notes);
  // Only checked when both ends are in the patch; a patch moving one end is
  // validated by the store against the stored value it leaves alone.
  if (patch.startDate && patch.endDate) {
    const dateError = validateCycleDates(patch.startDate, patch.endDate);
    if (dateError) throw new InvalidPatchError(dateError);
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: name, productId, startDate, endDate, notes.",
    );
  }
  return patch;
}

// ── Goals ─────────────────────────────────────────────────────────────────
// Thin wrappers plus the untrusted-body parsers. The measurement rules
// (period ordering, target-differs-from-start) live in core so both stores and
// both parsers reject the same thing with the same wording.

export async function listGoals(
  scope?: WorkspaceScope,
): Promise<GoalRecord[]> {
  const store = await getStore();
  return store.listGoals(scope);
}

export async function createGoal(
  input: GoalInput,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.createGoal(input, scope);
}

export async function updateGoal(
  id: string,
  patch: GoalPatch,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.updateGoal(id, patch, scope);
}

export async function deleteGoal(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteGoal(id, scope);
}

export async function createKeyResult(
  goalId: string,
  input: KeyResultInput,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.createKeyResult(goalId, input, scope);
}

export async function updateKeyResult(
  id: string,
  patch: KeyResultPatch,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.updateKeyResult(id, patch, scope);
}

export async function deleteKeyResult(
  id: string,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.deleteKeyResult(id, scope);
}

export async function listGoalContributions(
  goalId: string,
  scope?: WorkspaceScope,
): Promise<GoalContribution[]> {
  const store = await getStore();
  return store.listGoalContributions(goalId, scope);
}

export async function listItemGoals(
  specId: string,
  scope?: WorkspaceScope,
): Promise<ItemGoalRef[]> {
  const store = await getStore();
  return store.listItemGoals(specId, scope);
}

export async function linkGoal(
  goalId: string,
  specId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.linkGoal(goalId, specId, scope);
}

export async function unlinkGoal(
  goalId: string,
  specId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.unlinkGoal(goalId, specId, scope);
}

/** Parse and validate an untrusted goal POST body. */
export function parseGoalInput(body: unknown): GoalInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new InvalidPatchError("title is required.");
  }
  const input: GoalInput = { title: raw.title.trim() };
  if ("description" in raw) input.description = parseReleaseNotes(raw.description);
  if ("productId" in raw) input.productId = parseProductId(raw.productId);
  if ("periodStart" in raw)
    input.periodStart = parseDate(raw.periodStart, "periodStart");
  if ("periodEnd" in raw)
    input.periodEnd = parseDate(raw.periodEnd, "periodEnd");
  if ("parentGoalId" in raw && raw.parentGoalId !== null) {
    if (!isUuid(raw.parentGoalId)) {
      throw new InvalidPatchError("parentGoalId must be a UUID or null.");
    }
    input.parentGoalId = raw.parentGoalId;
  } else if ("parentGoalId" in raw) {
    input.parentGoalId = null;
  }
  if ("status" in raw) input.status = parseGoalStatus(raw.status);
  const periodError = validateGoalPeriod(
    input.periodStart ?? null,
    input.periodEnd ?? null,
  );
  if (periodError) throw new InvalidPatchError(periodError);
  return input;
}

/** Parse and validate an untrusted goal PATCH body. */
export function parseGoalPatch(body: unknown): GoalPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: GoalPatch = {};
  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      throw new InvalidPatchError("title must be a non-empty string.");
    }
    patch.title = raw.title.trim();
  }
  if ("description" in raw) patch.description = parseReleaseNotes(raw.description);
  if ("productId" in raw) patch.productId = parseProductId(raw.productId);
  if ("periodStart" in raw)
    patch.periodStart = parseDate(raw.periodStart, "periodStart");
  if ("periodEnd" in raw)
    patch.periodEnd = parseDate(raw.periodEnd, "periodEnd");
  if ("parentGoalId" in raw) {
    if (raw.parentGoalId !== null && !isUuid(raw.parentGoalId)) {
      throw new InvalidPatchError("parentGoalId must be a UUID or null.");
    }
    patch.parentGoalId = raw.parentGoalId as string | null;
  }
  if ("status" in raw) patch.status = parseGoalStatus(raw.status);
  // Only checked when both ends are in the patch; a patch moving one end is
  // validated by the store against the stored value it leaves alone.
  if (patch.periodStart !== undefined && patch.periodEnd !== undefined) {
    const periodError = validateGoalPeriod(
      patch.periodStart,
      patch.periodEnd,
    );
    if (periodError) throw new InvalidPatchError(periodError);
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: title, description, productId, " +
        "periodStart, periodEnd, parentGoalId, status.",
    );
  }
  return patch;
}

/** Parse and validate an untrusted key-result POST body. */
export function parseKeyResultInput(body: unknown): KeyResultInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new InvalidPatchError("title is required.");
  }
  const targetValue = parseFiniteNumber(raw.targetValue, "targetValue");
  if (targetValue === null) {
    throw new InvalidPatchError("targetValue is required.");
  }
  const input: KeyResultInput = { title: raw.title.trim(), targetValue };
  if ("metricKind" in raw) input.metricKind = parseMetricKind(raw.metricKind);
  const startValue = parseFiniteNumber(raw.startValue, "startValue");
  if (startValue !== null) input.startValue = startValue;
  const currentValue = parseFiniteNumber(raw.currentValue, "currentValue");
  if (currentValue !== null) input.currentValue = currentValue;
  const error = validateKeyResult({
    metricKind: input.metricKind ?? "number",
    startValue: input.startValue ?? 0,
    targetValue,
  });
  if (error) throw new InvalidPatchError(error);
  return input;
}

/** Parse and validate an untrusted key-result PATCH body. */
export function parseKeyResultPatch(body: unknown): KeyResultPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: KeyResultPatch = {};
  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      throw new InvalidPatchError("title must be a non-empty string.");
    }
    patch.title = raw.title.trim();
  }
  if ("metricKind" in raw) patch.metricKind = parseMetricKind(raw.metricKind);
  for (const key of ["startValue", "targetValue", "currentValue", "position"] as const) {
    if (!(key in raw)) continue;
    const value = parseFiniteNumber(raw[key], key);
    if (value === null) {
      throw new InvalidPatchError(`${key} must be a number.`);
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: title, metricKind, startValue, " +
        "targetValue, currentValue, position.",
    );
  }
  return patch;
}

function parseGoalStatus(value: unknown): GoalStatus {
  if (!isGoalStatus(value)) {
    throw new InvalidPatchError(
      `status must be one of: ${GOAL_STATUSES.join(", ")}.`,
    );
  }
  return value;
}

function parseMetricKind(value: unknown): MetricKind {
  if (!isMetricKind(value)) {
    throw new InvalidPatchError(
      `metricKind must be one of: ${METRIC_KINDS.join(", ")}.`,
    );
  }
  return value;
}

/** A finite number, or null when the key is absent/null (not an error). */
function parseFiniteNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidPatchError(`${label} must be a finite number.`);
  }
  return value;
}

/** Validate a productId: a non-empty string (product uuid) or null (portfolio). */
function parseProductId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError("productId must be a string or null.");
  }
  return value;
}

/** Validate release notes: a string (trimmed; empty becomes null) or null. */
function parseReleaseNotes(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError("notes must be a string or null.");
  }
  const trimmed = value.trim();
  if (trimmed.length > 10_000) {
    throw new InvalidPatchError("notes must be 10,000 characters or fewer.");
  }
  return trimmed || null;
}

/** Validate the customer-facing release-notes mode: none | in_app | external. */
function parseReleaseNotesMode(value: unknown): ReleaseNotesMode {
  if (
    typeof value !== "string" ||
    !(RELEASE_NOTES_MODES as readonly string[]).includes(value)
  ) {
    throw new InvalidPatchError(
      `releaseNotesMode must be one of: ${RELEASE_NOTES_MODES.join(", ")}.`,
    );
  }
  return value as ReleaseNotesMode;
}

/** Validate in-app release-notes body: a string (trimmed; empty → null) or null. */
function parseReleaseNotesBody(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError("releaseNotesBody must be a string or null.");
  }
  const trimmed = value.trim();
  if (trimmed.length > 50_000) {
    throw new InvalidPatchError(
      "releaseNotesBody must be 50,000 characters or fewer.",
    );
  }
  return trimmed || null;
}

/**
 * Validate an external release-notes URL: a string (trimmed; empty → null) or
 * null. Only http(s) URLs are accepted so the app never links out to a
 * `javascript:` or other scheme.
 */
function parseReleaseNotesUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError("releaseNotesUrl must be a string or null.");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2_048) {
    throw new InvalidPatchError(
      "releaseNotesUrl must be 2,048 characters or fewer.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidPatchError("releaseNotesUrl must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidPatchError("releaseNotesUrl must be an http(s) URL.");
  }
  return trimmed;
}

/**
 * Parse a customer-facing release-notes-only patch, for the `update_release_notes`
 * MCP tool. Returns a `ReleasePatch` limited to the `releaseNotes*` fields, so a
 * caller can author the notes without being able to touch a release's name,
 * status, dates, product, or the internal planning `notes`.
 *
 * `mode` may be given explicitly; when it isn't, it is inferred from the payload:
 * a non-empty `body` implies `in_app`, a non-empty `url` implies `external`, and
 * clearing the payload (empty/null body or url with no mode) implies `none`. The
 * stored body and url are retained across mode switches, so setting one mode
 * never clobbers the other's value.
 */
export function parseReleaseNotesPatch(body: unknown): ReleasePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: ReleasePatch = {};
  let mode: ReleaseNotesMode | undefined;
  if ("mode" in raw) mode = parseReleaseNotesMode(raw.mode);
  if ("body" in raw) patch.releaseNotesBody = parseReleaseNotesBody(raw.body);
  if ("url" in raw) patch.releaseNotesUrl = parseReleaseNotesUrl(raw.url);
  if (patch.releaseNotesBody !== undefined && patch.releaseNotesUrl) {
    throw new InvalidPatchError(
      "Provide an in-app `body` or an external `url`, not both.",
    );
  }
  // Infer the mode from the payload when it wasn't set explicitly.
  if (mode === undefined) {
    if (patch.releaseNotesBody) mode = "in_app";
    else if (patch.releaseNotesUrl) mode = "external";
    else if ("body" in raw || "url" in raw) mode = "none";
  }
  if (mode !== undefined) patch.releaseNotesMode = mode;
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Provide at least one of: mode, body, url.",
    );
  }
  return patch;
}

function parseReleaseStatus(value: unknown): ReleaseStatus {
  if (
    typeof value !== "string" ||
    !(RELEASE_STATUSES as readonly string[]).includes(value)
  ) {
    throw new InvalidPatchError(
      `status must be one of: ${RELEASE_STATUSES.join(", ")}.`,
    );
  }
  return value as ReleaseStatus;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new InvalidPatchError(`${field} must be YYYY-MM-DD or null.`);
  }
  return value;
}

// ── Ideas ──────────────────────────────────────────────────────────────────

/** The workspace's ideas the acting user can see, most-voted first. */
export async function listIdeas(
  scope?: WorkspaceScope,
): Promise<IdeaRecord[]> {
  const store = await getStore();
  return store.listIdeas(scope);
}

/** Capture a new idea. */
export async function createIdea(
  input: IdeaInput,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const store = await getStore();
  return store.createIdea(input, scope);
}

/** Update an idea's title/description/status/product. */
export async function updateIdea(
  id: string,
  patch: IdeaPatch,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const store = await getStore();
  return store.updateIdea(id, patch, scope);
}

/** Delete an idea (its votes cascade). */
export async function deleteIdea(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteIdea(id, scope);
}

/** Add or remove the acting user's vote for an idea. */
export async function setIdeaVote(
  id: string,
  voted: boolean,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const store = await getStore();
  return voted ? store.voteIdea(id, scope) : store.unvoteIdea(id, scope);
}

/** Promote an idea into a feature; returns both records. */
export async function promoteIdea(
  id: string,
  scope?: WorkspaceScope,
): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
  const store = await getStore();
  return store.promoteIdea(id, scope);
}

/** The workspace's idea review stages, or `[]` when using the built-in default. */
export async function listIdeaStatuses(
  scope?: WorkspaceScope,
): Promise<IdeaStage[]> {
  const store = await getStore();
  return store.listIdeaStatuses(scope);
}

/** Replace the workspace's idea review stages. */
export async function replaceIdeaStatuses(
  stages: StatusStageInput[],
  scope?: WorkspaceScope,
): Promise<IdeaStage[]> {
  const store = await getStore();
  return store.replaceIdeaStatuses(stages, scope);
}

/** The workspace's Ideas configuration (portal settings). */
export async function getIdeaSettings(
  scope?: WorkspaceScope,
): Promise<IdeaSettings> {
  const store = await getStore();
  return store.getIdeaSettings(scope);
}

/** Update the workspace's Ideas configuration. */
export async function updateIdeaSettings(
  patch: IdeaSettingsPatch,
  scope?: WorkspaceScope,
): Promise<IdeaSettings> {
  const store = await getStore();
  return store.updateIdeaSettings(patch, scope);
}

/** Parse and validate an untrusted idea-create body. */
export function parseIdeaInput(body: unknown): IdeaInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new InvalidPatchError("title is required.");
  }
  const input: IdeaInput = { title: raw.title.trim() };
  if ("description" in raw) input.description = parseNullableText(raw.description, "description");
  if ("productId" in raw) input.productId = parseNullableId(raw.productId, "productId");
  return input;
}

/** Parse and validate an untrusted idea PATCH body. */
export function parseIdeaPatch(body: unknown): IdeaPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: IdeaPatch = {};
  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      throw new InvalidPatchError("title must be a non-empty string.");
    }
    patch.title = raw.title.trim();
  }
  if ("description" in raw) {
    patch.description = parseNullableText(raw.description, "description");
  }
  if ("status" in raw) {
    if (typeof raw.status !== "string" || raw.status.trim() === "") {
      throw new InvalidPatchError("status must be a non-empty string.");
    }
    patch.status = raw.status;
  }
  if ("productId" in raw) {
    patch.productId = parseNullableId(raw.productId, "productId");
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: title, description, status, productId.",
    );
  }
  return patch;
}

/** Parse an untrusted `{ voted: boolean }` body for an idea vote toggle. */
export function parseIdeaVote(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const voted = (body as { voted?: unknown }).voted;
  if (typeof voted !== "boolean") {
    throw new InvalidPatchError("voted must be a boolean.");
  }
  return voted;
}

/** Parse and validate an untrusted Ideas-settings PATCH body. */
export function parseIdeaSettingsPatch(body: unknown): IdeaSettingsPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: IdeaSettingsPatch = {};
  if ("portalEnabled" in raw) {
    if (typeof raw.portalEnabled !== "boolean") {
      throw new InvalidPatchError("portalEnabled must be a boolean.");
    }
    patch.portalEnabled = raw.portalEnabled;
  }
  if ("portalTitle" in raw) {
    patch.portalTitle = parseNullableText(raw.portalTitle, "portalTitle");
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: portalEnabled, portalTitle.",
    );
  }
  return patch;
}

function parseNullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError(`${field} must be a string or null.`);
  }
  return value;
}

function parseNullableId(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError(`${field} must be a string id or null.`);
  }
  return value;
}

/**
 * Create a DB-native work item (initiative/epic). Validation lives in the store.
 *
 * A caller that says nothing about `details` gets the body the workspace
 * configured for that level (its detail template). The "New item" drawer seeds
 * the same template into its editor and then sends whatever the user left
 * there, including an explicit null when they cleared it, so seeding here only
 * fills the gap for the paths that never ask: the per-column quick add, the API,
 * the MCP tools.
 */
export async function createWorkItem(
  input: CreateFeatureInput,
  scope?: WorkspaceScope,
): Promise<FeatureRecord> {
  const store = await getStore();
  const seeded =
    input.details === undefined
      ? {
          ...input,
          details: await levelTemplateBody(store, input.level, scope),
        }
      : input;
  // The store records item.created in the create transaction (it builds the data
  // from the new row, since specId is generated there).
  const created = await store.createFeature(seeded, scope, "item.created");
  notifyOutbox();
  return created;
}

/** The body of the detail template assigned to `levelKey`, or null if the level
 * has no template (or the assigned one has since been deleted). */
async function levelTemplateBody(
  store: FeatureStore,
  levelKey: string,
  scope?: WorkspaceScope,
): Promise<string | null> {
  const levels = await store.listLevels(scope);
  const templateId = levels.find((l) => l.key === levelKey)?.detailTemplateId;
  if (!templateId) return null;
  const templates = await store.listDetailTemplates(scope);
  return templates.find((t) => t.id === templateId)?.body?.trim() || null;
}

/**
 * Delete a work item by id. An item with a spec attached needs `removeSpec`,
 * which deletes the spec file from git first: leaving it behind would let the
 * next sync re-import the spec and recreate the item (ADR 0003 D4). Without
 * the opt-in the store refuses and says so.
 */
export async function deleteWorkItem(
  specId: string,
  scope?: WorkspaceScope,
  opts: { removeSpec?: boolean } = {},
): Promise<void> {
  const store = await getStore();
  // Read the item first so the event can describe what was removed; the store
  // records item.deleted in the same transaction as the delete.
  const existing = await store.getFeature(specId, scope);
  const emit: OutboxEmit | undefined = existing
    ? {
        type: "item.deleted",
        productId: existing.productId,
        data: {
          specId: existing.specId,
          title: existing.title,
          level: existing.level,
        },
      }
    : undefined;

  // Remove the git file before the row. The other order would leave a spec in
  // the repo with no item to re-import onto if the git call then failed; this
  // order fails with the file already gone, which the next sync reconciles.
  let specRemoved = false;
  const hasSpec = existing != null && !existing.isDbNative;
  if (hasSpec && opts.removeSpec) {
    const db = getDb();
    if (!db) {
      throw new InvalidPatchError(
        "Removing a spec file needs a connected repository, which local file " +
          "mode has none of. Delete the file directly instead.",
      );
    }
    await deleteSpecFile(db, scope!, specId);
    specRemoved = true;
  }

  await store.deleteFeature(specId, scope, emit, {
    // Local file mode owns its working tree and removes the file itself, so it
    // just needs the confirmation; the DB store needs it to have already gone.
    specRemoved: specRemoved || (hasSpec && opts.removeSpec === true),
  });
  if (emit) notifyOutbox();
}

/** Parse and validate an untrusted relation-create body. */
export function parseRelationInput(body: unknown): RelationInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (!isUuid(raw.toSpecId)) {
    throw new InvalidPatchError("toSpecId must be a UUID.");
  }
  if (
    typeof raw.direction !== "string" ||
    !(RELATION_DIRECTIONS as readonly string[]).includes(raw.direction)
  ) {
    throw new InvalidPatchError(
      `direction must be one of: ${RELATION_DIRECTIONS.join(", ")}.`,
    );
  }
  return {
    toSpecId: raw.toSpecId,
    direction: raw.direction as CreatableRelationDirection,
  };
}

/** Create a relation from `specId`, returning its refreshed relation list. */
export async function addFeatureRelation(
  specId: string,
  input: RelationInput,
  scope?: WorkspaceScope,
): Promise<FeatureRelation[]> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);
  await store.addRelation(specId, input, scope);
  const updated = await store.getFeature(specId, scope);
  return updated?.relations ?? [];
}

/** Remove a relation by id, returning the refreshed relation list. */
export async function removeFeatureRelation(
  specId: string,
  linkId: string,
  scope?: WorkspaceScope,
): Promise<FeatureRelation[]> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);
  await store.removeRelation(specId, linkId, scope);
  const updated = await store.getFeature(specId, scope);
  return updated?.relations ?? [];
}
