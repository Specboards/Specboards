import {
  isPropertyEntity,
  isPropertyType,
  type PropertyDef,
} from "@specboards/core";
import { getStore, type WorkspaceScope } from "@/lib/store";
import type { PropertyInput, PropertyPatch } from "@/lib/store/types";
import { InvalidPatchError } from "@/lib/service-errors";

/** The custom properties a workspace defines for its items and releases. */

/** The workspace's custom property definitions, ordered by position. */
export async function listProperties(
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<PropertyDef[]> {
  const store = await getStore();
  return store.listProperties(scope, undefined, productId);
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
  productId?: string | null,
): Promise<PropertyDef> {
  const store = await getStore();
  return store.createProperty(input, scope, productId);
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
