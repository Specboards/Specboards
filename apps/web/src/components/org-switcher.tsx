"use client";

import { useRouter } from "next/navigation";

import { Select } from "@/components/ui/select";
import { ALL_PRODUCTS } from "@/lib/active-product";
import { orgProductPath } from "@/lib/org-path";
import { useOrgSlug } from "@/lib/use-org";

/**
 * Org switcher at the top of the sidebar. Hidden unless the user belongs to ≥2
 * orgs (the single-tenant / one-org case has nothing to switch). Selecting an
 * org navigates to its backlog; the product context resets to all products
 * with the org. See ADR 0001 (D3).
 */
export function OrgSwitcher({
  orgs,
}: {
  orgs: { slug: string; name: string }[];
}) {
  const router = useRouter();
  const active = useOrgSlug();

  if (orgs.length < 2) return null;

  return (
    <Select
      aria-label="Switch organization"
      value={active}
      onChange={(e) =>
        router.push(orgProductPath(e.target.value, ALL_PRODUCTS, "/backlog"))
      }
      className="h-8 text-sm"
    >
      {orgs.map((org) => (
        <option key={org.slug} value={org.slug}>
          {org.name}
        </option>
      ))}
    </Select>
  );
}
