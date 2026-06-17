"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusDot } from "@/components/status-dot";
import { StatusSelect } from "@/components/status-select";
import { priorityLabel } from "@/lib/feature-helpers";
import type { FeatureRecord } from "@/lib/store/types";

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
}: {
  rows: BacklogRow[];
  canEdit: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-14">Pri</TableHead>
          <TableHead>Feature</TableHead>
          <TableHead className="w-44">Status</TableHead>
          <TableHead className="w-14">Est</TableHead>
          <TableHead>Tags</TableHead>
          <TableHead className="w-24">Quarter</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map(({ feature: f, depth }) => {
          const isEpic = f.childCount > 0;
          const isCollapsed = collapsed.has(f.specId);
          return (
            <TableRow key={f.specId}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {priorityLabel(f.priority)}
              </TableCell>
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
                    href={`/feature/${f.specId}`}
                    className="font-medium hover:underline"
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
                <div className="text-xs text-muted-foreground">{f.path}</div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <StatusDot status={f.status} />
                  <StatusSelect
                    specId={f.specId}
                    status={f.status}
                    className="h-8 w-36"
                    canEdit={canEdit}
                  />
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {f.rolledEstimate === null ? (
                  "—"
                ) : (
                  <span
                    title={
                      isEpic
                        ? "Subtree total (rolled up from children)"
                        : undefined
                    }
                  >
                    {isEpic ? "Σ" : ""}
                    {f.rolledEstimate}
                  </span>
                )}
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
                {f.roadmapQuarter ?? "—"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
