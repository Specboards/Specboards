/**
 * Product permission rules — the TypeScript source of truth that mirrors the
 * Postgres RLS functions (`specboards_can_read_product` / `_write_ / _manage_`,
 * see migration 0012). The DB store relies on RLS; the local file store and the
 * UI use these helpers so all three agree on who can do what.
 *
 * Two layers:
 *  - **Org role** — the workspace `owner` can read/write/manage everything.
 *  - **Product role** — a per-product grant: `admin` (manage + edit),
 *    `contributor` (edit items), `viewer` (read a private product).
 *
 * Reads of an `org`-visibility product are open to every member; only `private`
 * products require the owner or an explicit product grant.
 */

import type { Product, ProductVisibility } from "./products.js";

/** A user's role on a single product. */
export type ProductRole = "admin" | "contributor" | "viewer";

/** A user's effective access across the org, evaluated by the helpers below. */
export interface ProductAccess {
  /** True when the user is the workspace owner (can do anything). */
  isOrgAdmin: boolean;
  /** product id → the user's explicit role on it (absent = no grant). */
  roles: ReadonlyMap<string, ProductRole>;
}

/** Access for auth-disabled local mode: a single all-powerful user. */
export const LOCAL_PRODUCT_ACCESS: ProductAccess = {
  isOrgAdmin: true,
  roles: new Map(),
};

/** The user's explicit role on a product, or null when they have no grant. */
export function productRole(
  access: ProductAccess,
  productId: string,
): ProductRole | null {
  return access.roles.get(productId) ?? null;
}

/**
 * Whether the user may read a product (and its items). Org admins and members
 * with any grant always can; otherwise it depends on the product's visibility.
 */
export function canReadProduct(
  access: ProductAccess,
  product: Pick<Product, "id" | "visibility"> | { id: string; visibility: ProductVisibility },
): boolean {
  if (access.isOrgAdmin) return true;
  if (product.visibility === "org") return true;
  return access.roles.has(product.id);
}

/** Whether the user may create/edit/delete items in a product. */
export function canWriteProduct(access: ProductAccess, productId: string): boolean {
  if (access.isOrgAdmin) return true;
  const role = access.roles.get(productId);
  return role === "admin" || role === "contributor";
}

/** Whether the user may manage a product's settings + membership. */
export function canManageProduct(access: ProductAccess, productId: string): boolean {
  if (access.isOrgAdmin) return true;
  return access.roles.get(productId) === "admin";
}
