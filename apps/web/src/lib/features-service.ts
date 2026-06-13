import { canTransition } from "@specboard/core";

import {
  getStore,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type WorkspaceScope,
} from "@/lib/store";

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

  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: status, priority, roadmapQuarter, tags, assigneeId, customFields.",
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

  if (patch.status !== undefined && !canTransition(feature.status, patch.status)) {
    throw new InvalidPatchError(
      `Illegal transition: ${feature.status} -> ${patch.status}`,
    );
  }

  await store.updateFeature(specId, patch, scope);
  const updated = await store.getFeature(specId, scope);
  return updated ?? feature;
}
