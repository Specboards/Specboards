import {
  canTransition,
  isForwardTransition,
  isValidParentLevel,
  shortestTransitionPath,
  transitionErrorMessage,
} from "@specboards/core";
import { RICE_IMPACT_VALUES } from "@/lib/feature-helpers";
import { applyItemReleaseCascade } from "@/lib/release-cascade-service";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { isUuid } from "@/lib/uuid";
import { notifyOutbox } from "@/lib/webhooks/events";
import {
  type FeatureDetail,
  type FeaturePatch,
  getStore,
  type OutboxEmit,
  type WorkspaceScope,
} from "@/lib/store";
import type { CreateFeatureInput } from "@/lib/store/types";
import { assertCustomFieldTypes, parseCustomFields } from "@/lib/custom-fields";
import { FeatureNotFoundError, InvalidPatchError } from "@/lib/service-errors";

/**
 * An item: reading a patch off the wire, and applying it.
 *
 * The core of the `/api/v1` domain layer. `patchFeature` is the single write
 * path for an item's own fields, so the transition rules, stage gates, and
 * parent scheduling checks are enforced in one place no caller can go around.
 *
 * Its siblings own the other resources: `bulk-patch-service` for the many-item
 * form of this same patch, `releases-service`, `cycles-service`,
 * `goals-service`, `ideas-service`, `workflow-service`, `levels-service`,
 * `properties-service`, `detail-templates-service`, `comments-service`,
 * `notifications-service`, `specs-service`, `work-items-service`, and
 * `relations-service`. Route handlers stay thin; validation and store access
 * live in whichever of these owns the resource.
 */

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

/** Options that change how a patch is applied, rather than what it sets. */
interface PatchOptions {
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
  /**
   * After setting `releaseId`, give the same release to the descendants that
   * are not scheduled anywhere yet.
   *
   * Off by default and never inferred. Setting a release on an epic moves one
   * row, which is how a release came to report four items while holding
   * twenty-one, but silently rewriting somebody's subtree because they touched
   * a parent would be the worse bug. What moves and what is deliberately left
   * alone is decided in `@/lib/release-cascade`.
   *
   * Runs after the item's own patch has committed, so it is an extra rather
   * than a gate: a cascade that fails part-way leaves the parent's change in
   * place and the items it already moved where they are.
   */
  cascadeRelease?: boolean;
}

/**
 * Apply a validated patch, enforcing the status workflow. With
 * {@link PatchOptions.advance} a multi-stage status move is walked one legal
 * hop at a time instead of rejected; with {@link PatchOptions.cascadeRelease} a
 * release change is carried down to the unscheduled work beneath the item.
 */
export async function patchFeature(
  specId: string,
  patch: FeaturePatch,
  scope?: WorkspaceScope,
  options?: PatchOptions,
): Promise<FeatureDetail> {
  const result = await applyPatch(specId, patch, scope, options);
  if (options?.cascadeRelease && patch.releaseId !== undefined) {
    await applyItemReleaseCascade(specId, patch.releaseId, scope);
  }
  return result;
}

/** The patch itself: one hop, or the advance walk. */
async function applyPatch(
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
  // The item's own product decides how it may move, not whichever board the
  // request came from: a cross-product view and a product board must agree
  // about the same item, and so must the API, which has no board at all.
  const workflow = await resolveWorkflowFor(scope ?? null, feature.productId);
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
    // Resolved for the item's product, for the reason given in patchFeature.
    const workflow = await resolveWorkflowFor(scope ?? null, feature.productId);
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
