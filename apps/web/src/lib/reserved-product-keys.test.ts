import { readdirSync } from "node:fs";
import { join } from "node:path";

import { RESERVED_PRODUCT_KEYS } from "@specboards/core";
import { describe, expect, it } from "vitest";

/**
 * The reserved product keys, checked against the routes that make them
 * necessary.
 *
 * A product lives at `/{org}/{key}/…`, and Next resolves a static segment
 * before the `[product]` dynamic one. So every static child of `app/[org]/` is
 * a key that would shadow a product, and `RESERVED_PRODUCT_KEYS` is the list of
 * them. The list is hand-written, because routes cannot be enumerated at
 * runtime, and a hand-written list is exactly the kind that drifts.
 *
 * This is the guard against that drift, and it runs in the right direction:
 * adding a route without reserving its name fails here, rather than silently
 * making some customer's product unreachable months later. The failure that
 * matters is a route with no reservation, so that is what the assertion names.
 *
 * `RESERVED_PRODUCT_KEYS` lives in core (where `productKeyFromName` needs it)
 * and the routes live here, which is why this test is in the web app rather
 * than beside the set it checks.
 */

const ORG_ROUTES = join(process.cwd(), "src", "app", "[org]");

/** Static children of `app/[org]/`: the segments that beat `[product]`. */
function staticOrgSegments(): string[] {
  return readdirSync(ORG_ROUTES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    // `[product]` is the dynamic segment these would shadow, not a shadower.
    .filter((e) => !e.name.startsWith("[") && !e.name.startsWith("("))
    .map((e) => e.name)
    .sort();
}

describe("reserved product keys match the route tree", () => {
  it("reserves every static segment under /[org]", () => {
    const unreserved = staticOrgSegments().filter(
      (segment) => !RESERVED_PRODUCT_KEYS.has(segment),
    );
    expect(
      unreserved,
      "these routes would shadow a product with the same key; add them to " +
        "RESERVED_PRODUCT_KEYS in packages/core/src/products.ts",
    ).toEqual([]);
  });

  it("finds the segments at all", () => {
    // Guards the guard. If the directory moved or the filter over-matched, the
    // assertion above would pass against an empty list and prove nothing.
    const segments = staticOrgSegments();
    expect(segments.length).toBeGreaterThan(0);
    expect(segments).toContain("settings");
  });

  it("does not reserve names no route needs", () => {
    // The list costs customers names, so it should not outgrow its reason.
    // Every reserved key must correspond to a real route, with one exception:
    // `ideas` is reserved ahead of the public portal's routes existing, which
    // is deliberate. Reserving it after somebody had taken it would be too
    // late, and the alternative is shipping the portal and discovering the
    // clash then.
    const routes = new Set(staticOrgSegments());
    const withoutRoute = [...RESERVED_PRODUCT_KEYS].filter(
      (key) => !routes.has(key),
    );
    expect(withoutRoute.sort()).toEqual(["ideas"]);
  });
});
