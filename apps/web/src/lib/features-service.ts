import {
  canTransition,
  isForwardTransition,
  transitionErrorMessage,
  isPropertyType,
  isValidParentLevel,
  propertyKeyFromLabel,
  type PropertyDef,
} from "@specboard/core";

import { resolveWorkflowFor } from "@/lib/repo-config";
import { notifyOutbox } from "@/lib/webhooks/events";
import {
  getStore,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type OutboxEmit,
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
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type LevelUpdate,
  type PropertyInput,
  type PropertyPatch,
  type RelationInput,
  type ReleaseInput,
  type ReleasePatch,
  type ReleaseRecord,
  type ReleaseStatus,
  type StageGate,
  type StageGateInput,
  type StatusStageInput,
  type WorkspaceStatus,
} from "@/lib/store/types";
import type { IdeaStage } from "@specboard/core";

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
  // Capture the prior status so we can detect the ship edge for the webhook.
  const before = (await store.listReleases(scope)).find((r) => r.id === id) ?? null;

  // Record release.shipped in the same transaction as the ship. A ship patch is
  // status-only in practice; apply any name/date overrides in the patch so the
  // payload reflects the post-update release (itemCount is unaffected by status).
  let emit: OutboxEmit | undefined;
  if (before && before.status !== "shipped" && patch.status === "shipped") {
    emit = {
      type: "release.shipped",
      // A product release scopes its event to that product; a portfolio
      // release (null productId) stays workspace-level.
      productId: patch.productId !== undefined ? patch.productId : before.productId,
      data: {
        releaseId: before.id,
        name: patch.name?.trim() || before.name,
        startDate: patch.startDate !== undefined ? patch.startDate : before.startDate,
        targetDate:
          patch.targetDate !== undefined ? patch.targetDate : before.targetDate,
        itemCount: before.itemCount,
      },
    };
  }

  const updated = await store.updateRelease(id, patch, scope, emit);
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

/** The workspace's workflow stages, or `[]` when using the built-in default. */
export async function listStatuses(
  scope?: WorkspaceScope,
): Promise<WorkspaceStatus[]> {
  const store = await getStore();
  return store.listStatuses(scope);
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
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: name, productId, status, " +
        "startDate, targetDate, notes.",
    );
  }
  return patch;
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

/** Create a DB-native work item (initiative/epic). Validation lives in the store. */
export async function createWorkItem(
  input: CreateFeatureInput,
  scope?: WorkspaceScope,
): Promise<FeatureRecord> {
  const store = await getStore();
  // The store records item.created in the create transaction (it builds the data
  // from the new row, since specId is generated there).
  const created = await store.createFeature(input, scope, "item.created");
  notifyOutbox();
  return created;
}

/** Delete a DB-native work item by id. */
export async function deleteWorkItem(
  specId: string,
  scope?: WorkspaceScope,
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
  await store.deleteFeature(specId, scope, emit);
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
