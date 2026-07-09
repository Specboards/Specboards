import { describe, expect, it } from "vitest";

import {
  canManageProduct,
  canReadProduct,
  canWriteProduct,
  LOCAL_PRODUCT_ACCESS,
  productRole,
  type ProductAccess,
} from "./permissions.js";

const orgProduct = { id: "p1", visibility: "org" as const };
const privateProduct = { id: "p2", visibility: "private" as const };

function access(
  isOrgAdmin: boolean,
  roles: Record<string, "admin" | "contributor" | "viewer"> = {},
): ProductAccess {
  return { isOrgAdmin, roles: new Map(Object.entries(roles)) };
}

describe("canReadProduct", () => {
  it("lets any member read an org-visibility product", () => {
    expect(canReadProduct(access(false), orgProduct)).toBe(true);
  });

  it("hides a private product from a member with no grant", () => {
    expect(canReadProduct(access(false), privateProduct)).toBe(false);
  });

  it("lets an org admin read a private product", () => {
    expect(canReadProduct(access(true), privateProduct)).toBe(true);
  });

  it("lets a granted member (even viewer) read a private product", () => {
    expect(canReadProduct(access(false, { p2: "viewer" }), privateProduct)).toBe(true);
  });
});

describe("canWriteProduct", () => {
  it("denies a viewer grant", () => {
    expect(canWriteProduct(access(false, { p1: "viewer" }), "p1")).toBe(false);
  });

  it("allows contributor and admin grants", () => {
    expect(canWriteProduct(access(false, { p1: "contributor" }), "p1")).toBe(true);
    expect(canWriteProduct(access(false, { p1: "admin" }), "p1")).toBe(true);
  });

  it("allows an org admin regardless of grant", () => {
    expect(canWriteProduct(access(true), "p1")).toBe(true);
  });

  it("denies a member with no grant on the product", () => {
    expect(canWriteProduct(access(false, { other: "admin" }), "p1")).toBe(false);
  });
});

describe("canManageProduct", () => {
  it("requires an admin grant (contributor is not enough)", () => {
    expect(canManageProduct(access(false, { p1: "contributor" }), "p1")).toBe(false);
    expect(canManageProduct(access(false, { p1: "admin" }), "p1")).toBe(true);
  });

  it("allows an org admin", () => {
    expect(canManageProduct(access(true), "p1")).toBe(true);
  });
});

describe("productRole", () => {
  it("returns the explicit grant or null", () => {
    expect(productRole(access(false, { p1: "contributor" }), "p1")).toBe("contributor");
    expect(productRole(access(false), "p1")).toBeNull();
  });
});

describe("LOCAL_PRODUCT_ACCESS", () => {
  it("is an all-powerful org admin (auth-disabled local mode)", () => {
    expect(canReadProduct(LOCAL_PRODUCT_ACCESS, privateProduct)).toBe(true);
    expect(canWriteProduct(LOCAL_PRODUCT_ACCESS, "anything")).toBe(true);
    expect(canManageProduct(LOCAL_PRODUCT_ACCESS, "anything")).toBe(true);
  });
});
