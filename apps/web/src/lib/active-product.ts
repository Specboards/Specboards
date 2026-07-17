import { descendantGroupIds } from "@specboard/core";

import type { ProductGroupRecord, ProductRecord } from "@/lib/store";

/** Sentinel `?product=` value for the cross-product "All products" view. */
export const ALL_PRODUCTS = "all";

/**
 * Prefix marking the `/{org}/{...}/` product segment as a product-group scope
 * (`~platform`). Product keys only contain `[a-z0-9-]` (see core
 * `productKeyFromName`), so a `~`-prefixed segment can never collide with a
 * product, and `~` needs no URL encoding.
 */
export const GROUP_SLUG_PREFIX = "~";

/**
 * What the `/{org}/{product}/…` segment resolves to: every product ("all"),
 * one product, or a product group (with the products in its subtree).
 */
export type ActiveScope =
  | { kind: "all" }
  | { kind: "product"; product: ProductRecord }
  | {
      kind: "group";
      group: ProductGroupRecord;
      /** Ids of readable products in the group's subtree (recursive). */
      productIds: Set<string>;
    };

/**
 * Resolve the active product for a list view from the `?product=` query param.
 * Returns the matching product, or null for the cross-product "All products"
 * view — the default when the param is missing, "all", or names an unknown
 * (or no-longer-visible) product.
 */
export function resolveActiveProduct(
  products: ProductRecord[],
  raw: string | string[] | undefined,
): ProductRecord | null {
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || key === ALL_PRODUCTS) return null;
  return products.find((p) => p.key === key) ?? null;
}

/**
 * Resolve the `/{org}/{product}/…` segment to a scope. Returns null when the
 * segment names an unknown (or not-visible) product or group, so pages can
 * 404. `products` is the viewer's readable list, so a group scope's
 * `productIds` only ever contains readable products; a group whose subtree
 * holds none resolves with an empty set (pages render it empty, and roll-up
 * surfaces hide it up front).
 */
export function resolveActiveScope(
  products: ProductRecord[],
  groups: ProductGroupRecord[],
  raw: string | string[] | undefined,
): ActiveScope | null {
  const segment = Array.isArray(raw) ? raw[0] : raw;
  if (!segment || segment === ALL_PRODUCTS) return { kind: "all" };
  if (segment.startsWith(GROUP_SLUG_PREFIX)) {
    const key = segment.slice(GROUP_SLUG_PREFIX.length);
    const group = groups.find((g) => g.key === key);
    if (!group) return null;
    const subtree = descendantGroupIds(groups, group.id);
    const productIds = new Set(
      products.filter((p) => p.groupId && subtree.has(p.groupId)).map((p) => p.id),
    );
    return { kind: "group", group, productIds };
  }
  const product = products.find((p) => p.key === segment);
  return product ? { kind: "product", product } : null;
}

/** The products a scope covers, for filtering feature lists. */
export function scopeProductFilter(
  scope: ActiveScope,
): (productId: string | null) => boolean {
  if (scope.kind === "all") return () => true;
  if (scope.kind === "product") {
    const id = scope.product.id;
    return (productId) => productId === id;
  }
  const ids = scope.productIds;
  return (productId) => productId !== null && ids.has(productId);
}
