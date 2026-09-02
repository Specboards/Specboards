import { isUuid } from "@/lib/uuid";
import {
  getStore,
  type WorkspaceLevel,
  type WorkspaceScope,
} from "@/lib/store";
import type { LevelUpdate } from "@/lib/store/types";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * The hierarchy levels a workspace defines, and the fields and templates
 * attached to each.
 *
 * A level is what makes "initiative" and "epic" mean something in a given
 * workspace, so almost every other resource reads these; few write them.
 */

/** The workspace's hierarchy levels (top → leaf). */
export async function listLevels(
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const store = await getStore();
  return store.listLevels(scope, productId);
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
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const store = await getStore();
  return store.updateLevelFields(fields, scope, productId);
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
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const store = await getStore();
  return store.updateLevelTemplates(templates, scope, productId);
}
