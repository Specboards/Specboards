"use client";

import { ListChecks } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { StatusWorkflow } from "@specboard/core";

import { type ProductTag } from "@/components/feature-card";
import { StatusDot } from "@/components/status-dot";
import { StatusSelect } from "@/components/status-select";
import { productColorClasses } from "@/lib/product-color";
import type { FeatureRecord } from "@/lib/store/types";
import { useOrgProductPath } from "@/lib/use-org";
import { cn } from "@/lib/utils";
import { BulkActionBar, type BulkOptions } from "./bulk-action-bar";

export interface BacklogRow {
  feature: FeatureRecord;
  depth: number;
}

const STORAGE_KEY = "specboard:backlog:collapsed";

/**
 * Backlog table with collapsible epics. Rows arrive pre-ordered as a
 * hierarchy (each epic followed by its children); collapsing an epic hides
 * its descendant rows. Collapsed epics persist in localStorage so the view
 * survives navigation and refresh.
 */
export function BacklogTable({
  rows,
  canEdit,
  workflow,
  productsById,
  releaseNames,
  bulkOptions,
}: {
  rows: BacklogRow[];
  canEdit: boolean;
  workflow?: StatusWorkflow;
  /** Product identity by id; when set, a Product column is shown (the
   * cross-product "All products" view). */
  productsById?: Record<string, ProductTag>;
  /** Release name by id, for the Release column. */
  releaseNames: Record<string, string>;
  /** Option lists for the bulk action bar; enables multi-select when provided
   * (editors only). */
  bulkOptions?: BulkOptions;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Multi-select is opt-in: the checkbox column appears only once turned on.
  const [selectMode, setSelectMode] = useState(false);
  const orgHref = useOrgProductPath();
  const canSelect = canEdit && !!bulkOptions;

  // Hydrate persisted collapsed set after mount (avoids SSR/client mismatch).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
    } catch {
      // Ignore unparseable/unavailable storage — default to all expanded.
    }
  }, []);

  const toggle = useCallback((specId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(specId)) next.delete(specId);
      else next.add(specId);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Persistence is best-effort.
      }
      return next;
    });
  }, []);

  const visible = rows.filter(
    ({ feature }) =>
      !feature.parentSpecId || !collapsed.has(feature.parentSpecId),
  );

  const toggleSelect = useCallback((specId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(specId)) next.delete(specId);
      else next.add(specId);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  // Select-all toggles just the currently visible rows (collapsed epics' hidden
  // children are left alone, matching what the user can see).
  const visibleIds = useMemo(
    () => visible.map(({ feature }) => feature.specId),
    [visible],
  );
  const selectedVisibleCount = visibleIds.filter((id) => selected.has(id)).length;
  const allVisibleSelected =
    visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const everySelected =
        visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      if (everySelected) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  }, [visibleIds]);

  // Esc leaves multi-select entirely.
  useEffect(() => {
    if (!selectMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") exitSelect();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelect]);

  return (
    <>
    {canSelect ? (
      <div className="mb-2 flex justify-end">
        <Button
          type="button"
          size="sm"
          variant={selectMode ? "secondary" : "outline"}
          onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          className="h-8 gap-1.5"
        >
          <ListChecks className="h-4 w-4" />
          {selectMode ? "Done" : "Select"}
        </Button>
      </div>
    ) : null}
    <Table>
      <TableHeader>
        <TableRow>
          {selectMode ? (
            <TableHead className="w-8">
              <input
                type="checkbox"
                aria-label="Select all visible items"
                className="h-4 w-4 cursor-pointer align-middle accent-primary"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      selectedVisibleCount > 0 && !allVisibleSelected;
                }}
                onChange={toggleSelectAll}
              />
            </TableHead>
          ) : null}
          <TableHead>Feature</TableHead>
          {productsById ? <TableHead className="w-32">Product</TableHead> : null}
          <TableHead className="w-44">Status</TableHead>
          <TableHead>Tags</TableHead>
          <TableHead className="w-32">Release</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map(({ feature: f, depth }) => {
          const isEpic = f.childCount > 0;
          const isCollapsed = collapsed.has(f.specId);
          return (
            <TableRow key={f.specId} data-selected={selected.has(f.specId)}>
              {selectMode ? (
                <TableCell className="w-8">
                  <input
                    type="checkbox"
                    aria-label={`Select ${f.title}`}
                    className="h-4 w-4 cursor-pointer align-middle accent-primary"
                    checked={selected.has(f.specId)}
                    onChange={() => toggleSelect(f.specId)}
                  />
                </TableCell>
              ) : null}
              <TableCell>
                <span
                  className="flex items-center gap-2"
                  style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
                >
                  {isEpic ? (
                    <button
                      type="button"
                      onClick={() => toggle(f.specId)}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? "Expand epic" : "Collapse epic"}
                      className="-ml-1 w-4 text-muted-foreground hover:text-foreground"
                    >
                      {isCollapsed ? "▸" : "▾"}
                    </button>
                  ) : depth > 0 ? (
                    <span className="text-muted-foreground">↳</span>
                  ) : null}
                  <Link
                    href={orgHref(`/backlog/${f.level}/${f.specId}`)}
                    className="font-medium text-link hover:underline"
                  >
                    {f.title}
                  </Link>
                  {f.childCount > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[10px]"
                      title={`${f.childDoneCount} of ${f.childCount} children done`}
                    >
                      epic {f.childDoneCount}/{f.childCount}
                    </Badge>
                  )}
                  {f.blockedByCount > 0 && (
                    <Badge
                      variant="destructive"
                      className="text-[10px]"
                      title={`Blocked by ${f.blockedByCount} feature(s)`}
                    >
                      Blocked
                    </Badge>
                  )}
                </span>
                <div className="font-mono text-xs text-muted-foreground">
                  {f.path}
                </div>
              </TableCell>
              {productsById ? (
                <TableCell>
                  {(() => {
                    const p = f.productId ? productsById[f.productId] : undefined;
                    return p ? (
                      <Badge
                        variant="secondary"
                        className={cn("border-transparent text-[10px]", productColorClasses(p).badge)}
                      >
                        {p.name}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    );
                  })()}
                </TableCell>
              ) : null}
              <TableCell>
                <div className="flex items-center gap-2">
                  <StatusDot status={f.status} />
                  <StatusSelect
                    specId={f.specId}
                    status={f.status}
                    className="h-8 w-36"
                    canEdit={canEdit}
                    workflow={workflow}
                  />
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {f.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {f.releaseId ? (releaseNames[f.releaseId] ?? "—") : "—"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    {selectMode && bulkOptions ? (
      <BulkActionBar
        selectedIds={[...selected]}
        options={bulkOptions}
        onClear={clearSelection}
        onExit={exitSelect}
      />
    ) : null}
    </>
  );
}
