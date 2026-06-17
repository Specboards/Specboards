import { canTransition } from "@specboard/core";

import { resolveWorkflowFor } from "@/lib/repo-config";
import {
  getStore,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type WorkspaceScope,
} from "@/lib/store";
import {
  RELATION_DIRECTIONS,
  type CreatableRelationDirection,
  type FeatureRelation,
  type RelationInput,
} from "@/lib/store/types";

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

  if ("status" in raw) {
    if (typeof raw.status !== "string" || raw.status === "") {
      throw new InvalidPatchError("status must be a non-empty string.");
    }
    patch.status = raw.status;
  }
  if ("priority" in raw) {
    if (raw.priority !== null && (typeof raw.priority !== "number" || !Number.isInteger(raw.priority))) {
      throw new InvalidPatchError("priority must be an integer or null.");
    }
    patch.priority = raw.priority as number | null;
  }
  if ("estimate" in raw) {
    if (
      raw.estimate !== null &&
      (typeof raw.estimate !== "number" ||
        !Number.isInteger(raw.estimate) ||
        raw.estimate < 0)
    ) {
      throw new InvalidPatchError(
        "estimate must be a non-negative integer or null.",
      );
    }
    patch.estimate = raw.estimate as number | null;
  }
  if ("roadmapQuarter" in raw) {
    if (raw.roadmapQuarter !== null && typeof raw.roadmapQuarter !== "string") {
      throw new InvalidPatchError("roadmapQuarter must be a string or null.");
    }
    patch.roadmapQuarter = (raw.roadmapQuarter as string | null)?.trim() || null;
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
  if ("parentSpecId" in raw) {
    if (raw.parentSpecId !== null && !isUuid(raw.parentSpecId)) {
      throw new InvalidPatchError("parentSpecId must be a UUID or null.");
    }
    patch.parentSpecId = raw.parentSpecId as string | null;
  }

  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: status, priority, estimate, roadmapQuarter, tags, assigneeId, customFields, parentSpecId.",
    );
  }
  return patch;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
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

/** Apply a validated patch, enforcing the status workflow. */
export async function patchFeature(
  specId: string,
  patch: FeaturePatch,
  scope?: WorkspaceScope,
): Promise<FeatureDetail> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);

  if (patch.status !== undefined) {
    const workflow = await resolveWorkflowFor(scope ?? null);
    if (!canTransition(feature.status, patch.status, workflow)) {
      throw new InvalidPatchError(
        `Illegal transition: ${feature.status} -> ${patch.status}`,
      );
    }
  }

  if (patch.parentSpecId) {
    await assertNoParentCycle(specId, patch.parentSpecId, scope);
  }

  await store.updateFeature(specId, patch, scope);
  const updated = await store.getFeature(specId, scope);
  return updated ?? feature;
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
