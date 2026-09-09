import { describe, expect, it } from "vitest";

import {
  isReservedProductKey,
  PRODUCT_COLORS,
  productKeyFromName,
  resolveProductColor,
} from "./products.js";

describe("reserved product keys", () => {
  it("never mints a key a route would shadow", () => {
    // The bug this exists for, and it predates the portal: a product is
    // addressed at /{org}/{key}, Next resolves a static segment before the
    // [product] one, so a product called "Settings" got key `settings` and was
    // simply unreachable. No error at creation, nothing to see afterwards
    // except a board that never opens.
    expect(productKeyFromName("Settings", new Set())).toBe("settings-2");
    expect(productKeyFromName("Dashboard", new Set())).toBe("dashboard-2");
    expect(productKeyFromName("Ideas", new Set())).toBe("ideas-2");
    // Ugly, and reachable. That is the trade.
  });

  it("still disambiguates past a reserved key that is also taken", () => {
    expect(productKeyFromName("Ideas", new Set(["ideas-2"]))).toBe("ideas-3");
  });

  it("does not reserve a key merely for containing a reserved one", () => {
    // Equality, not prefix: every reservation costs a customer a name, and
    // `settings-hub` collides with nothing.
    for (const ok of ["settings-hub", "ideas-portal", "dashboards"]) {
      expect(isReservedProductKey(ok), ok).toBe(false);
    }
  });
});

describe("productKeyFromName", () => {
  it("slugifies a name", () => {
    expect(productKeyFromName("Mobile App", new Set())).toBe("mobile-app");
  });

  it("disambiguates against taken keys", () => {
    expect(productKeyFromName("Web", new Set(["web"]))).toBe("web-2");
    expect(productKeyFromName("Web", new Set(["web", "web-2"]))).toBe("web-3");
  });

  it("falls back to 'product' for empty slugs", () => {
    expect(productKeyFromName("!!!", new Set())).toBe("product");
  });
});

describe("resolveProductColor", () => {
  it("returns an explicit color when it is a known token", () => {
    expect(resolveProductColor({ color: "blue", key: "web" })).toBe("blue");
  });

  it("derives a palette color from the key when color is null/unset", () => {
    const c = resolveProductColor({ color: null, key: "web" });
    expect(PRODUCT_COLORS).toContain(c);
  });

  it("is deterministic for a given key", () => {
    expect(resolveProductColor({ key: "mobile" })).toBe(
      resolveProductColor({ key: "mobile" }),
    );
  });

  it("ignores an unknown color token and derives from the key", () => {
    expect(resolveProductColor({ color: "fuchsia", key: "web" })).toBe(
      resolveProductColor({ color: null, key: "web" }),
    );
  });
});
