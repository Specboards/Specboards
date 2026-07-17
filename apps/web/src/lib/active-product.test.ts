import { describe, expect, it } from "vitest";

import {
  resolveActiveProduct,
  resolveActiveScope,
  scopeProductFilter,
} from "./active-product";
import type { ProductGroupRecord, ProductRecord } from "@/lib/store";

function product(over: Partial<ProductRecord> & { id: string; key: string }): ProductRecord {
  return {
    name: over.key,
    description: null,
    visibility: "org",
    position: 0,
    color: null,
    groupId: null,
    itemCount: 0,
    viewerRole: null,
    ...over,
  };
}

function group(
  over: Partial<ProductGroupRecord> & { id: string; key: string },
): ProductGroupRecord {
  return {
    name: over.key,
    description: null,
    color: null,
    parentId: null,
    position: 0,
    productCount: 0,
    ...over,
  };
}

/** platform > payments; web in platform, checkout in payments, docs ungrouped. */
const GROUPS = [
  group({ id: "g-platform", key: "platform" }),
  group({ id: "g-payments", key: "payments", parentId: "g-platform" }),
];
const PRODUCTS = [
  product({ id: "p-web", key: "web", groupId: "g-platform" }),
  product({ id: "p-checkout", key: "checkout", groupId: "g-payments" }),
  product({ id: "p-docs", key: "docs" }),
];

describe("resolveActiveScope", () => {
  it("resolves 'all' and missing segments to the all scope", () => {
    expect(resolveActiveScope(PRODUCTS, GROUPS, "all")).toEqual({ kind: "all" });
    expect(resolveActiveScope(PRODUCTS, GROUPS, undefined)).toEqual({
      kind: "all",
    });
  });

  it("resolves a product key to a product scope", () => {
    const scope = resolveActiveScope(PRODUCTS, GROUPS, "web");
    expect(scope?.kind).toBe("product");
    if (scope?.kind === "product") expect(scope.product.id).toBe("p-web");
  });

  it("resolves a ~key segment to a group scope with subtree products", () => {
    const scope = resolveActiveScope(PRODUCTS, GROUPS, "~platform");
    expect(scope?.kind).toBe("group");
    if (scope?.kind === "group") {
      expect(scope.group.id).toBe("g-platform");
      expect(scope.productIds).toEqual(new Set(["p-web", "p-checkout"]));
    }
  });

  it("scopes a child group to just its own products", () => {
    const scope = resolveActiveScope(PRODUCTS, GROUPS, "~payments");
    if (scope?.kind === "group") {
      expect(scope.productIds).toEqual(new Set(["p-checkout"]));
    } else {
      throw new Error("expected a group scope");
    }
  });

  it("returns null for unknown products and groups", () => {
    expect(resolveActiveScope(PRODUCTS, GROUPS, "nope")).toBeNull();
    expect(resolveActiveScope(PRODUCTS, GROUPS, "~nope")).toBeNull();
  });
});

describe("scopeProductFilter", () => {
  it("passes everything for the all scope", () => {
    const f = scopeProductFilter({ kind: "all" });
    expect(f("p-web")).toBe(true);
    expect(f(null)).toBe(true);
  });

  it("matches only the product for a product scope", () => {
    const scope = resolveActiveScope(PRODUCTS, GROUPS, "docs")!;
    const f = scopeProductFilter(scope);
    expect(f("p-docs")).toBe(true);
    expect(f("p-web")).toBe(false);
    expect(f(null)).toBe(false);
  });

  it("matches subtree products for a group scope", () => {
    const scope = resolveActiveScope(PRODUCTS, GROUPS, "~platform")!;
    const f = scopeProductFilter(scope);
    expect(f("p-web")).toBe(true);
    expect(f("p-checkout")).toBe(true);
    expect(f("p-docs")).toBe(false);
    expect(f(null)).toBe(false);
  });
});

describe("resolveActiveProduct (legacy)", () => {
  it("still resolves keys and treats unknown as all/null", () => {
    expect(resolveActiveProduct(PRODUCTS, "web")?.id).toBe("p-web");
    expect(resolveActiveProduct(PRODUCTS, "all")).toBeNull();
  });
});
