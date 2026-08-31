"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Select } from "@/components/ui/select";
import type { ProductRecord } from "@/lib/store/types";

/** `?product=` value for the workspace default. Empty so the param drops out. */
const WORKSPACE_SCOPE = "";

/**
 * Which product the Cards settings page is configuring.
 *
 * The failure mode this guards against is an admin editing the wrong product's
 * workflow without noticing, which is worse than the bug that started this epic
 * because it changes real behaviour rather than none. So the scope lives in the
 * URL rather than in component state: it survives a refresh, it is visible in
 * the address bar, it can be linked to a colleague, and every panel below is
 * server-rendered for it rather than each keeping its own idea of the scope.
 *
 * Hidden until there is more than one product, per the UX conventions: with one
 * product a default and an override are the same sentence said twice, and a
 * single-product workspace should see the page exactly as it was.
 */
export function CardsScopePicker({
  products,
  active,
  manageableProductIds,
  canEditDefault,
}: {
  products: ProductRecord[];
  /** Product id being configured, or null for the workspace default. */
  active: string | null;
  manageableProductIds: string[];
  canEditDefault: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (products.length < 2) return null;

  const manageable = new Set(manageableProductIds);

  function choose(next: string) {
    const query = new URLSearchParams(params.toString());
    if (next === WORKSPACE_SCOPE) query.delete("product");
    else query.set("product", next);
    const suffix = query.toString();
    startTransition(() => {
      router.replace(suffix ? `?${suffix}` : "?", { scroll: false });
    });
  }

  const editable = active === null ? canEditDefault : manageable.has(active);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-4 py-3">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Configuring</span>
        <Select
          value={active ?? WORKSPACE_SCOPE}
          onChange={(e) => choose(e.target.value)}
          className="h-8 w-auto min-w-56"
          disabled={pending}
        >
          <option value={WORKSPACE_SCOPE}>
            Workspace default (all products)
          </option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-xs text-muted-foreground">
        {active === null
          ? "These settings apply to every product that has not overridden them."
          : editable
            ? "Settings this product has not overridden follow the workspace default."
            : "You need to be an admin of this product to change its settings."}
      </p>
    </div>
  );
}
