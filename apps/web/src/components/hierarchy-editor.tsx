"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthRequiredError, updateLevels } from "@/lib/api-client";
import type { WorkspaceLevel } from "@/lib/store/types";

/** One editable row; `key` is set for existing levels, undefined for new ones. */
interface Row {
  /** Stable React key for the row (the level key, or a synthetic id). */
  rowId: string;
  /** Persisted level key, or undefined for a not-yet-saved level. */
  key?: string;
  label: string;
  isLeaf: boolean;
}

/**
 * Editor for the workspace's work-tracking hierarchy (e.g. Initiative → Epic →
 * Feature). Rename levels, add intermediate levels, or remove unused ones. The
 * bottom (leaf) level holds the git-synced specs — it's pinned and can't be
 * removed or reordered. Saving replaces the whole configuration.
 */
export function HierarchyEditor({
  levels,
  canEdit,
}: {
  levels: WorkspaceLevel[];
  canEdit: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    levels.map((l) => ({ rowId: l.key, key: l.key, label: l.label, isLeaf: l.isLeaf })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const newIdCounter = useRef(0);

  const leafIndex = rows.findIndex((r) => r.isLeaf);

  function setLabel(rowId: string, label: string) {
    setRows((rs) => rs.map((r) => (r.rowId === rowId ? { ...r, label } : r)));
  }

  function removeRow(rowId: string) {
    setRows((rs) => rs.filter((r) => r.rowId !== rowId));
  }

  /** Add a new (empty) intermediate level just above the leaf. */
  function addRow() {
    const rowId = `new-${newIdCounter.current++}`;
    setRows((rs) => {
      const idx = rs.findIndex((r) => r.isLeaf);
      const at = idx < 0 ? rs.length : idx;
      const next = [...rs];
      next.splice(at, 0, { rowId, label: "", isLeaf: false });
      return next;
    });
  }

  function onSave() {
    if (rows.some((r) => r.label.trim() === "")) {
      setError("Every level needs a name.");
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        const updated = await updateLevels(
          rows.map((r) => ({ key: r.key, label: r.label.trim() })),
        );
        setRows(
          updated.map((l) => ({
            rowId: l.key,
            key: l.key,
            label: l.label,
            isLeaf: l.isLeaf,
          })),
        );
        toast.success("Hierarchy saved");
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          window.location.href = "/sign-in";
          return;
        }
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  if (!canEdit) {
    return (
      <div className="space-y-3">
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <li
              key={r.rowId}
              className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
              <span className="font-medium">{r.label}</span>
              {r.isLeaf ? (
                <span className="text-xs text-muted-foreground">· from specs</span>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Only an admin can change the hierarchy.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-4">
      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.rowId} className="flex items-center gap-2">
            <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
            <Input
              value={r.label}
              onChange={(e) => setLabel(r.rowId, e.target.value)}
              placeholder="Level name"
              className="h-8"
            />
            {r.isLeaf ? (
              <span className="w-28 shrink-0 text-xs text-muted-foreground">
                Leaf · from specs
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-28 shrink-0 text-muted-foreground"
                onClick={() => removeRow(r.rowId)}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ol>

      {leafIndex >= 0 ? (
        <Button type="button" size="sm" variant="outline" onClick={addRow}>
          Add level
        </Button>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Levels run top to bottom, broadest first. The bottom level holds your
        git-synced specs and can't be removed. A level can only be removed once
        nothing uses it.
      </p>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <Button type="button" size="sm" onClick={onSave} disabled={pending}>
        {pending ? "Saving…" : "Save hierarchy"}
      </Button>
    </div>
  );
}
