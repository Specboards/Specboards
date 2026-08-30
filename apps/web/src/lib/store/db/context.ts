/**
 * The vocabulary every domain module of the Postgres store shares.
 *
 * Step 3 of the FeatureStore split moves `db/index.ts` out one domain at a
 * time. A domain module is plain functions rather than methods, so whatever it
 * used to reach for through `this` has to be named explicitly: that is
 * `DbStoreContext`. `DbStore` implements it and passes itself, so the calls
 * resolve to the same code they always did.
 *
 * Nothing here escapes `lib/store/db/`. `store/index.ts` hands callers a
 * `FeatureStore` and this is below that line.
 */

import { canReadProduct, canWriteProduct } from "@specboards/core";

import { type Database } from "@specboards/db";

import type { ProductAccess, WorkspaceScope } from "../types";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ProductVisibilityRow = { id: string; visibility: "org" | "private" };

/**
 * What a domain module may ask of the store it belongs to.
 *
 * Deliberately small. These are the members more than one domain needs: the
 * scoped transaction runner, and the two workspace lookups (who is acting, and
 * is this product real) that every product-scoped authorization check starts
 * from. It grows as further domains move out, and each addition should be a
 * member genuinely shared rather than one domain's helper made public.
 */
export interface DbStoreContext {
  /**
   * Run `fn` in a transaction with the RLS session variable set for `scope`.
   * See the implementation on `DbStore` for why an absent scope throws rather
   * than defaulting.
   */
  scoped<T>(
    scope: WorkspaceScope | undefined,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T>;
  /** Build the acting user's product access (org-admin flag + per-product roles). */
  accessIn(tx: Tx, scope: WorkspaceScope): Promise<ProductAccess>;
  /** Verify a product id belongs to the workspace, returning it. */
  requireProductId(tx: Tx, ws: string, productId: string): Promise<string>;
}

export function canReadProductId(
  access: ProductAccess,
  productById: ReadonlyMap<string, ProductVisibilityRow>,
  productId: string | null,
): boolean {
  if (productId === null) return true;
  const product = productById.get(productId);
  return product ? canReadProduct(access, product) : false;
}

export function canWriteProductId(
  access: ProductAccess,
  productId: string | null,
): boolean {
  if (productId === null) return access.isOrgAdmin;
  return canWriteProduct(access, productId);
}

/** The terminal status used for hierarchy roll-up progress. */
export function isDone(status: string): boolean {
  return status === "done";
}
