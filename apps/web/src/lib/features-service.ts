import {
  canTransition,
  isPropertyType,
  isValidParentLevel,
  type PropertyDef,
} from "@specboard/core";

import { resolveWorkflowFor } from "@/lib/repo-config";
import {
  getStore,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type WorkspaceScope,
  type WorkspaceLevel,
} from "@/lib/store";
import {
  RELATION_DIRECTIONS,
  RELEASE_STATUSES,
  type CreatableRelationDirection,
  type CreateFeatureInput,
  type DetailTemplate,
  type DetailTemplateInput,
  type DetailTemplatePatch,
  type FeatureRelation,
  type LevelUpdate,
  type PropertyInput,
  type PropertyPatch,
  type RelationInput,
  type ReleaseInput,
  type ReleasePatch,
  type ReleaseRecord,
  type ReleaseStatus,
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
      "Patch must set at least one of: title, status, rank, tags, releaseId, assigneeId, customFields, parentSpecId, details.",
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

  if (patch.title !== undefined && !feature.isDbNative) {
    throw new InvalidPatchError(
      "Spec-backed item titles come from the spec. Edit the title in git.",
    );
  }

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

  if ("productId" in raw && raw.productId !== null) {
    if (!isUuid(raw.productId)) {
      throw new InvalidPatchError("productId must be a UUID or null.");
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
  if ("tags" in raw) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string")) {
      throw new InvalidPatchError("tags must be an array of strings.");
    }
    input.tags = (raw.tags as string[]).map((t) => t.trim()).filter(Boolean);
  }
  if ("details" in raw && raw.details !== null) {
    if (typeof raw.details !== "string") {
      throw new InvalidPatchError("details must be a string or null.");
    }
    if (raw.details.length > 100_000) {
      throw new InvalidPatchError("details is too long.");
    }
    input.details = raw.details;
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
  if ("options" in raw) input.options = parseStringArray(raw.options, "options");
  if ("levels" in raw && raw.levels !== null) {
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

/** Create a release. */
export async function createRelease(
  input: ReleaseInput,
  scope?: WorkspaceScope,
): Promise<ReleaseRecord> {
  const store = await getStore();
  return store.createRelease(input, scope);
}

/** Update a release. */
export async function updateRelease(
  id: string,
  patch: ReleasePatch,
  scope?: WorkspaceScope,
): Promise<ReleaseRecord> {
  const store = await getStore();
  return store.updateRelease(id, patch, scope);
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
  if ("status" in raw) input.status = parseReleaseStatus(raw.status);
  if ("startDate" in raw) input.startDate = parseDate(raw.startDate, "startDate");
  if ("targetDate" in raw) input.targetDate = parseDate(raw.targetDate, "targetDate");
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
  if ("status" in raw) patch.status = parseReleaseStatus(raw.status);
  if ("startDate" in raw) patch.startDate = parseDate(raw.startDate, "startDate");
  if ("targetDate" in raw) patch.targetDate = parseDate(raw.targetDate, "targetDate");
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: name, status, startDate, targetDate.",
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

/** Create a DB-native work item (initiative/epic). Validation lives in the store. */
export async function createWorkItem(
  input: CreateFeatureInput,
  scope?: WorkspaceScope,
): Promise<FeatureRecord> {
  const store = await getStore();
  return store.createFeature(input, scope);
}

/** Delete a DB-native work item by id. */
export async function deleteWorkItem(
  specId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteFeature(specId, scope);
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
