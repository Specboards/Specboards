/**
 * Products: sibling backlogs within an organization (the workspace). Each
 * product holds its own work-tracking hierarchy (see `levels`). This module is
 * the framework-agnostic shape + small helpers; the rows themselves live in the
 * `products` table and permission rules live in `permissions`.
 */

/** A product's read visibility (see `permissions`). */
export type ProductVisibility = "org" | "private";

export interface Product {
  id: string;
  /** Stable slug used in the `?product=` URL and as the per-workspace key. */
  key: string;
  name: string;
  description: string | null;
  visibility: ProductVisibility;
  /** Manual ordering in the product switcher; ascending. */
  position: number;
  /** Chosen accent color token (see `PRODUCT_COLORS`), or null to derive one
   * deterministically from the key via `resolveProductColor`. */
  color: string | null;
}

/** The reserved key for the default product seeded on migration / first run. */
export const DEFAULT_PRODUCT_KEY = "default";

/**
 * Product keys that a real route already owns.
 *
 * A product is addressed at `/{org}/{key}/…`, and Next resolves a static
 * segment before the `[product]` dynamic one. So a product whose key equals a
 * static sibling of `[product]` is simply unreachable: every link to it lands
 * on the other page instead.
 *
 * This is not hypothetical and it is not new. `productKeyFromName` derives a key
 * by slugifying the name, so a product called "Settings" has always produced
 * `settings` and been shadowed by `/{org}/settings`, silently, with no error at
 * creation and no clue afterwards beyond the board never opening.
 *
 * `ideas` joins the list because the public portal lives at `/{org}/ideas`. It
 * is the entry that prompted an audit of the rest.
 *
 * Kept beside the keys rather than derived from the route tree because there is
 * no way to enumerate routes at runtime, and a list that silently stops
 * matching the filesystem is worse than one somebody has to remember: a test
 * asserts every static child of `app/[org]/` appears here, so adding a route
 * without adding it fails the build rather than shadowing somebody's product.
 */
export const RESERVED_PRODUCT_KEYS: ReadonlySet<string> = new Set([
  "dashboard",
  "notifications",
  "repositories",
  "settings",
  // The public Ideas portal: /{org}/ideas and /{org}/ideas/{product}.
  "ideas",
]);

/** Whether `key` collides with a route that would shadow the product. */
export function isReservedProductKey(key: string): boolean {
  return RESERVED_PRODUCT_KEYS.has(key);
}

/**
 * The accent-color palette a product can be tagged with. Stored as a stable
 * token (not a hex value) so the UI maps it to theme-aware classes and the set
 * stays closed/validatable. Order also drives the deterministic fallback.
 */
export const PRODUCT_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
] as const;

export type ProductColor = (typeof PRODUCT_COLORS)[number];

/**
 * The product's accent color: its explicit `color` when set to a known token,
 * otherwise one derived deterministically from its `key` so every product is
 * visually distinct out of the box (no backfill) yet stable across renders.
 */
export function resolveProductColor(p: {
  color?: string | null;
  key: string;
}): ProductColor {
  if (p.color && (PRODUCT_COLORS as readonly string[]).includes(p.color)) {
    return p.color as ProductColor;
  }
  let hash = 0;
  for (let i = 0; i < p.key.length; i++) {
    hash = (hash * 31 + p.key.charCodeAt(i)) >>> 0;
  }
  return PRODUCT_COLORS[hash % PRODUCT_COLORS.length] ?? PRODUCT_COLORS[0];
}

const KEY_MAX = 48;

/**
 * Derive a stable product key from a name, unique against `taken` and never one
 * a route already owns. Mirrors the level/workspace slug helpers so URLs stay
 * readable.
 *
 * Reserved keys are avoided here rather than at the call sites, which is the
 * whole point: there are two of them (the DB and local stores) and the failure
 * is invisible, so a check somebody has to remember to write is a check that
 * eventually is not written. A product named "Settings" becomes `settings-2`,
 * which is ugly and reachable, rather than `settings`, which is neither.
 */
export function productKeyFromName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, KEY_MAX) || "product";
  let key = base;
  let n = 2;
  while (taken.has(key) || isReservedProductKey(key)) key = `${base}-${n++}`;
  return key;
}
