"use client";

import { usePathname, useRouter } from "next/navigation";

import { descendantGroupIds } from "@specboard/core";

import { Select } from "@/components/ui/select";
import { ALL_PRODUCTS, GROUP_SLUG_PREFIX } from "@/lib/active-product";
import { orgProductPath } from "@/lib/org-path";
import type { ProductGroupRecord, ProductRecord } from "@/lib/store";
import { useOrgSlug, useProductSlug } from "@/lib/use-org";

/** A group flattened for display: "Parent / Child" label, tree order. */
interface FlatGroup {
  group: ProductGroupRecord;
  label: string;
}

/**
 * Flatten the group tree depth-first (position order among siblings) so
 * native selects, which can't nest optgroups, still read hierarchically.
 * Cycle-safe: a corrupt parent chain is rendered at the top level.
 */
function flattenGroups(groups: ProductGroupRecord[]): FlatGroup[] {
  const byParent = new Map<string | null, ProductGroupRecord[]>();
  const ids = new Set(groups.map((g) => g.id));
  for (const g of groups) {
    // Treat a dangling/unknown parent as top-level rather than dropping it.
    const parent = g.parentId && ids.has(g.parentId) ? g.parentId : null;
    const list = byParent.get(parent);
    if (list) list.push(g);
    else byParent.set(parent, [g]);
  }
  const out: FlatGroup[] = [];
  const walk = (parent: string | null, prefix: string, seen: Set<string>) => {
    for (const g of byParent.get(parent) ?? []) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const label = prefix ? `${prefix} / ${g.name}` : g.name;
      out.push({ group: g, label });
      walk(g.id, label, seen);
    }
  };
  walk(null, "", new Set());
  return out;
}

/**
 * Product switcher in the sidebar. Drives the `/{org}/{product}/…` segment
 * (ADR 0001 D5): "All products", a scope per product group (`~key`), and one
 * option per product, grouped under its group when it has one. Selecting one
 * keeps the current area (backlog / roadmap), defaulting to backlog.
 * Hidden when there's nothing to switch between (<2 products and no groups).
 */
export function ProductSwitcher({
  products,
  groups = [],
}: {
  products: ProductRecord[];
  groups?: ProductGroupRecord[];
}) {
  const router = useRouter();
  const org = useOrgSlug();
  const active = useProductSlug();
  const pathname = usePathname();

  // Only show groups whose subtree contains a product the viewer can read
  // (products is already the viewer's readable list), so private-only groups
  // don't advertise themselves as empty scopes.
  const flat = flattenGroups(groups).filter(({ group }) => {
    const subtree = descendantGroupIds(groups, group.id);
    return products.some((p) => p.groupId && subtree.has(p.groupId));
  });
  const grouped = new Set(flat.map(({ group }) => group.id));
  const ungrouped = products.filter((p) => !p.groupId || !grouped.has(p.groupId));

  if (products.length < 2 && flat.length === 0) return null;

  // Preserve the area we're on when already inside a product; else land on
  // backlog.
  const segs = pathname.split("/");
  const area = active !== ALL_PRODUCTS && segs[3] ? segs[3] : "backlog";

  return (
    <Select
      aria-label="Switch product"
      value={active}
      onChange={(e) => router.push(orgProductPath(org, e.target.value, `/${area}`))}
      className="h-8 text-sm"
    >
      <option value={ALL_PRODUCTS}>All products</option>
      {flat.map(({ group, label }) => (
        <optgroup key={group.id} label={label}>
          <option value={`${GROUP_SLUG_PREFIX}${group.key}`}>
            All of {group.name}
          </option>
          {products
            .filter((p) => p.groupId === group.id)
            .map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
        </optgroup>
      ))}
      {flat.length > 0 && ungrouped.length > 0 ? (
        <optgroup label="Other products">
          {ungrouped.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </optgroup>
      ) : (
        ungrouped.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
          </option>
        ))
      )}
    </Select>
  );
}
