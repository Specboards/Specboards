"use client";

import { usePathname, useRouter } from "next/navigation";

import { Select } from "@/components/ui/select";
import { ALL_PRODUCTS } from "@/lib/active-product";
import { orgProductPath } from "@/lib/org-path";
import type { ProductRecord } from "@/lib/store";
import { useOrgSlug, useProductSlug } from "@/lib/use-org";

/**
 * Product switcher in the sidebar. Drives the `/{org}/{product}/…` segment
 * (ADR 0001 D5): "All products" plus one option per product. Selecting one
 * keeps the current area (backlog / roadmap), defaulting to backlog.
 * Hidden until there are ≥2 products (nothing to switch between).
 */
export function ProductSwitcher({ products }: { products: ProductRecord[] }) {
  const router = useRouter();
  const org = useOrgSlug();
  const active = useProductSlug();
  const pathname = usePathname();

  if (products.length < 2) return null;

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
      {products.map((p) => (
        <option key={p.key} value={p.key}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}
