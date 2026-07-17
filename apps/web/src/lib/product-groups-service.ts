import { PRODUCT_COLORS } from "@specboard/core";

import { InvalidPatchError } from "@/lib/features-service";
import {
  getStore,
  type CreateProductGroupInput,
  type GroupSummary,
  type ProductGroupPatch,
  type ProductGroupRecord,
  type WorkspaceScope,
} from "@/lib/store";

/**
 * Domain operations behind /api/v1/product-groups. Route handlers stay thin;
 * validation and store access live here. Groups are org-admin managed
 * (enforced in the routes via `authorizeOrgAdmin`); metadata is visible to
 * every member.
 */

const COLORS: readonly string[] = PRODUCT_COLORS;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Validate an optional `color`: a known palette token, or null to clear it. */
function parseColor(raw: Record<string, unknown>): string | null {
  if (raw.color === null) return null;
  if (typeof raw.color !== "string" || !COLORS.includes(raw.color)) {
    throw new InvalidPatchError(`color must be one of: ${COLORS.join(", ")}.`);
  }
  return raw.color;
}

/** Validate an optional `parentId`: a UUID, or null for top-level. */
function parseParentId(raw: Record<string, unknown>): string | null {
  if (raw.parentId === null) return null;
  if (!isUuid(raw.parentId)) {
    throw new InvalidPatchError("parentId must be a UUID or null.");
  }
  return raw.parentId;
}

export async function listProductGroups(
  scope?: WorkspaceScope,
): Promise<ProductGroupRecord[]> {
  const store = await getStore();
  return store.listProductGroups(scope);
}

/** Parse and validate an untrusted create-group body. */
export function parseCreateProductGroupInput(
  body: unknown,
): CreateProductGroupInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidPatchError("name is required.");
  }
  const input: CreateProductGroupInput = { name: raw.name.trim() };
  if ("description" in raw && raw.description !== null) {
    if (typeof raw.description !== "string") {
      throw new InvalidPatchError("description must be a string or null.");
    }
    input.description = raw.description.trim() || null;
  }
  if ("color" in raw) input.color = parseColor(raw);
  if ("parentId" in raw) input.parentId = parseParentId(raw);
  return input;
}

export async function createProductGroup(
  input: CreateProductGroupInput,
  scope?: WorkspaceScope,
): Promise<ProductGroupRecord> {
  const store = await getStore();
  return store.createProductGroup(input, scope);
}

/** Parse and validate an untrusted group-patch body. */
export function parseProductGroupPatch(body: unknown): ProductGroupPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: ProductGroupPatch = {};
  if ("name" in raw) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidPatchError("name must be a non-empty string.");
    }
    patch.name = raw.name.trim();
  }
  if ("description" in raw) {
    if (raw.description !== null && typeof raw.description !== "string") {
      throw new InvalidPatchError("description must be a string or null.");
    }
    patch.description = (raw.description as string | null)?.trim() || null;
  }
  if ("color" in raw) patch.color = parseColor(raw);
  if ("parentId" in raw) patch.parentId = parseParentId(raw);
  if ("position" in raw) {
    if (typeof raw.position !== "number" || !Number.isInteger(raw.position)) {
      throw new InvalidPatchError("position must be an integer.");
    }
    patch.position = raw.position;
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: name, description, color, parentId, position.",
    );
  }
  return patch;
}

export async function updateProductGroup(
  id: string,
  patch: ProductGroupPatch,
  scope?: WorkspaceScope,
): Promise<ProductGroupRecord> {
  const store = await getStore();
  return store.updateProductGroup(id, patch, scope);
}

export async function deleteProductGroup(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteProductGroup(id, scope);
}

/** A group's roll-up over the readable products in its subtree. */
export async function getGroupSummary(
  id: string,
  scope?: WorkspaceScope,
): Promise<GroupSummary> {
  const store = await getStore();
  return store.getGroupSummary(id, scope);
}
