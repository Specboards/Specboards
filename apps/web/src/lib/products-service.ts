import { canManageProduct, PRODUCT_COLORS, type ProductAccess } from "@specboard/core";

import { InvalidPatchError } from "@/lib/features-service";
import {
  getStore,
  type CreateProductInput,
  type ProductMemberInput,
  type ProductMemberRecord,
  type ProductPatch,
  type ProductRecord,
  type ProductRole,
  type ProductVisibility,
  type WorkspaceScope,
} from "@/lib/store";

/**
 * Domain operations behind /api/v1/products. Route handlers stay thin;
 * validation and store access live here. Authorization (org-admin to create,
 * product-admin to manage) is enforced in the routes via `getProductAccess` +
 * the core permission helpers.
 */

const VISIBILITIES: readonly ProductVisibility[] = ["org", "private"];
const PRODUCT_ROLES: readonly ProductRole[] = ["admin", "contributor", "viewer"];
const COLORS: readonly string[] = PRODUCT_COLORS;

/** Validate an optional `color`: a known palette token, or null to clear it. */
function parseColor(raw: Record<string, unknown>): string | null {
  if (raw.color === null) return null;
  if (typeof raw.color !== "string" || !COLORS.includes(raw.color)) {
    throw new InvalidPatchError(`color must be one of: ${COLORS.join(", ")}.`);
  }
  return raw.color;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** The acting user's effective product access (for route authorization). */
export async function getProductAccess(
  scope?: WorkspaceScope,
): Promise<ProductAccess> {
  const store = await getStore();
  return store.getProductAccess(scope);
}

/** Whether the acting scope may manage a product (org admin or product admin). */
export async function canManageProductForScope(
  productId: string,
  scope?: WorkspaceScope,
): Promise<boolean> {
  return canManageProduct(await getProductAccess(scope), productId);
}

export async function listProducts(
  scope?: WorkspaceScope,
): Promise<ProductRecord[]> {
  const store = await getStore();
  return store.listProducts(scope);
}

/** Parse and validate an untrusted create-product body. */
export function parseCreateProductInput(body: unknown): CreateProductInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidPatchError("name is required.");
  }
  const input: CreateProductInput = { name: raw.name.trim() };
  if ("description" in raw && raw.description !== null) {
    if (typeof raw.description !== "string") {
      throw new InvalidPatchError("description must be a string or null.");
    }
    input.description = raw.description.trim() || null;
  }
  if ("visibility" in raw) {
    if (!VISIBILITIES.includes(raw.visibility as ProductVisibility)) {
      throw new InvalidPatchError(`visibility must be one of: ${VISIBILITIES.join(", ")}.`);
    }
    input.visibility = raw.visibility as ProductVisibility;
  }
  if ("color" in raw) input.color = parseColor(raw);
  return input;
}

export async function createProduct(
  input: CreateProductInput,
  scope?: WorkspaceScope,
): Promise<ProductRecord> {
  const store = await getStore();
  return store.createProduct(input, scope);
}

/** Parse and validate an untrusted product-patch body. */
export function parseProductPatch(body: unknown): ProductPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: ProductPatch = {};
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
  if ("visibility" in raw) {
    if (!VISIBILITIES.includes(raw.visibility as ProductVisibility)) {
      throw new InvalidPatchError(`visibility must be one of: ${VISIBILITIES.join(", ")}.`);
    }
    patch.visibility = raw.visibility as ProductVisibility;
  }
  if ("position" in raw) {
    if (typeof raw.position !== "number" || !Number.isInteger(raw.position)) {
      throw new InvalidPatchError("position must be an integer.");
    }
    patch.position = raw.position;
  }
  if ("color" in raw) patch.color = parseColor(raw);
  if ("groupId" in raw) {
    if (raw.groupId !== null && !isUuid(raw.groupId)) {
      throw new InvalidPatchError("groupId must be a UUID or null.");
    }
    patch.groupId = raw.groupId as string | null;
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: name, description, visibility, position, color, groupId.",
    );
  }
  return patch;
}

export async function updateProduct(
  id: string,
  patch: ProductPatch,
  scope?: WorkspaceScope,
): Promise<ProductRecord> {
  const store = await getStore();
  return store.updateProduct(id, patch, scope);
}

export async function deleteProduct(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteProduct(id, scope);
}

export async function listProductMembers(
  productId: string,
  scope?: WorkspaceScope,
): Promise<ProductMemberRecord[]> {
  const store = await getStore();
  return store.listProductMembers(productId, scope);
}

/** Parse and validate an untrusted product-member body ({ userId, role }). */
export function parseProductMemberInput(body: unknown): ProductMemberInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (!isUuid(raw.userId)) {
    throw new InvalidPatchError("userId must be a UUID.");
  }
  if (!PRODUCT_ROLES.includes(raw.role as ProductRole)) {
    throw new InvalidPatchError(`role must be one of: ${PRODUCT_ROLES.join(", ")}.`);
  }
  return { userId: raw.userId, role: raw.role as ProductRole };
}

export async function setProductMember(
  productId: string,
  input: ProductMemberInput,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.setProductMember(productId, input, scope);
}

export async function removeProductMember(
  productId: string,
  userId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.removeProductMember(productId, userId, scope);
}
