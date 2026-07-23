"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { PropertyDef, StatusWorkflow } from "@specboards/core";

import {
  CustomFieldInput,
  collectCustomFields,
} from "@/components/item-properties";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AuthRequiredError, createWorkItem } from "@/lib/api-client";
import { statusLabel } from "@/lib/feature-helpers";
import type { WorkspaceMember } from "@/lib/workspace";

/**
 * "New {level}" button + drawer for creating a DB-native work item (an
 * initiative/epic — a non-leaf level). Leaf items come from spec sync, so this
 * is only rendered for non-leaf levels. `parents` are the items one level up
 * that the new item may sit under (empty when there's no parent level).
 */
export function WorkItemCreate({
  levelKey,
  levelLabel,
  parentLabel,
  parents,
  productId,
  products,
  releases = [],
  defaultReleaseId = null,
  properties = [],
  workflow,
  members = [],
  templateBody = "",
}: {
  levelKey: string;
  levelLabel: string;
  /** Label of the parent level (e.g. "Initiative"), or null when top-level. */
  parentLabel: string | null;
  parents: { specId: string; title: string; productId?: string | null }[];
  /** Product the new item belongs to; null defers to the default product. */
  productId?: string | null;
  /** Products to choose from in the cross-product ("All products") view, where
   * no single product is in context. Omitted/empty when scoped to a product. */
  products?: { id: string; name: string }[];
  /** Releases the new item may be scheduled into. Portfolio releases
   * (productId null) and releases in the item's product are offered. */
  releases?: { id: string; name: string; productId: string | null }[];
  /** Pre-selected release (e.g. when adding from a roadmap column). */
  defaultReleaseId?: string | null;
  /** Workspace custom-property definitions; those applying to this level are
   * offered on the create form. */
  properties?: PropertyDef[];
  /** Workspace status workflow; the first status is the default for new items. */
  workflow: StatusWorkflow;
  /** Assignable workspace members. */
  members?: WorkspaceMember[];
  /** Markdown seeded into the Details editor (from the level's template). */
  templateBody?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [pending, startTransition] = useTransition();

  // Custom properties that apply at the level being created (null levels = all).
  const levelProperties = properties.filter(
    (p) => !p.levels || p.levels.includes(levelKey),
  );

  const statuses = workflow.statuses;
  const defaultStatus = statuses[0] ?? "backlog";

  // Offer a product picker only when no product is in context (all-products
  // view) and there's more than one to choose between.
  const showProductPicker = !productId && (products?.length ?? 0) > 1;
  const [selectedProduct, setSelectedProduct] = useState(
    () => productId ?? products?.[0]?.id ?? null,
  );

  // In the picker, only parents in the chosen product are valid (the server
  // doesn't cross-check, so filtering here keeps the hierarchy single-product).
  const visibleParents = showProductPicker
    ? parents.filter((p) => p.productId === selectedProduct)
    : parents;

  // The product this item will belong to, tracked reactively so the release
  // list narrows with the product picker. Releases offered: portfolio releases
  // (no product) plus releases scoped to this product.
  const chosenProductId = showProductPicker ? selectedProduct : (productId ?? null);
  const visibleReleases = releases.filter(
    (r) => r.productId === null || r.productId === chosenProductId,
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    if (!title) {
      setError("Title is required.");
      return;
    }
    const parentSpecId = String(data.get("parentSpecId") ?? "") || null;
    const status = String(data.get("status") ?? defaultStatus) || defaultStatus;
    const assigneeId = String(data.get("assigneeId") ?? "") || null;
    const releaseId = String(data.get("releaseId") ?? "") || null;
    const details = String(data.get("details") ?? "").trim() || null;
    // Only collect custom fields the user opted to fill in, and send just the
    // values they actually set (drop empties so a blank field stays unset).
    const collected = showCustom
      ? collectCustomFields(levelProperties, data, {})
      : {};
    const customFields = Object.fromEntries(
      Object.entries(collected).filter(
        ([, v]) => v !== null && !(Array.isArray(v) && v.length === 0),
      ),
    );
    startTransition(async () => {
      setError(null);
      try {
        await createWorkItem({
          title,
          level: levelKey,
          parentSpecId,
          productId: chosenProductId,
          status,
          assigneeId,
          releaseId,
          ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
          details,
        });
        toast.success(`${levelLabel} created`);
        setOpen(false);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        New {levelLabel.toLowerCase()}
      </Button>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setShowCustom(false);
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>New {levelLabel.toLowerCase()}</SheetTitle>
          </SheetHeader>
          {/* Remount the form each time the drawer opens so a fresh status,
              empty assignee, and the level's template body are restored. */}
          <form key={open ? "open" : "closed"} onSubmit={onSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Title
              </span>
              <Input name="title" autoFocus className="h-8" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Status
              </span>
              <Select name="status" defaultValue={defaultStatus} className="h-8">
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s, workflow)}
                  </option>
                ))}
              </Select>
            </label>
            {members.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Assigned to
                </span>
                <Select name="assigneeId" defaultValue="" className="h-8">
                  <option value="">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {visibleReleases.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Release
                </span>
                {/* Remount on product change so a now-invalid release resets. */}
                <Select
                  key={chosenProductId ?? "all"}
                  name="releaseId"
                  defaultValue={defaultReleaseId ?? ""}
                  className="h-8"
                >
                  <option value="">No release</option>
                  {visibleReleases.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Details
              </span>
              <MarkdownEditor
                name="details"
                defaultValue={templateBody}
                placeholder="Describe the problem to solve, or the spec…"
              />
            </div>
            {showProductPicker ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Product
                </span>
                <Select
                  value={selectedProduct ?? ""}
                  onChange={(e) => setSelectedProduct(e.target.value || null)}
                  className="h-8"
                >
                  {products!.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {parentLabel ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Parent ({parentLabel.toLowerCase()})
                </span>
                {/* Remount on product change so a now-invalid parent resets. */}
                <Select
                  key={selectedProduct ?? "all"}
                  name="parentSpecId"
                  defaultValue=""
                  className="h-8"
                >
                  <option value="">None</option>
                  {visibleParents.map((p) => (
                    <option key={p.specId} value={p.specId}>
                      {p.title}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {levelProperties.length > 0 ? (
              <div className="space-y-2">
                {/* Custom fields start collapsed (an affordance, not an open
                    form) so the drawer stays lean when they aren't needed. */}
                <Button
                  type="button"
                  variant="link"
                  size="inline"
                  onClick={() => setShowCustom((v) => !v)}
                  className="text-xs font-normal text-muted-foreground"
                >
                  {showCustom ? "Hide custom fields" : "Set custom fields"}
                </Button>
                {showCustom ? (
                  <div className="space-y-3 rounded-md border border-input p-3">
                    {levelProperties.map((p) => (
                      <label key={p.key} className="block space-y-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          {p.label}
                        </span>
                        <CustomFieldInput
                          property={p}
                          value={null}
                          members={members}
                        />
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Creating…" : `Create ${levelLabel.toLowerCase()}`}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
