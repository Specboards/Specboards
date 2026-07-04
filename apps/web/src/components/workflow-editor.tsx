"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthRequiredError, updateStatuses } from "@/lib/api-client";
import { statusDotClassFor } from "@/lib/feature-helpers";
import { cn } from "@/lib/utils";
import type { WorkspaceStatus } from "@/lib/store/types";

/** A stage being edited. `key` is empty for stages added in this session; the
 *  server assigns one from the label on save (existing keys stay stable). */
interface Row {
  key: string;
  label: string;
}

/**
 * Admin editor for the item workflow stages (the board columns items move
 * through). Rename a stage in place (its key, and so its items, stay put),
 * reorder, add, or remove stages. Removing a stage re-homes its items to the
 * first stage. `archived` is a system status and isn't listed here.
 */
export function WorkflowEditor({
  initial,
  canEdit,
}: {
  /** The current effective stages (DB-defined, or the built-in default). */
  initial: WorkspaceStatus[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(
    initial.map((s) => ({ key: s.key, label: s.label })),
  );
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dirty =
    rows.length !== initial.length ||
    rows.some((r, i) => r.key !== initial[i]?.key || r.label !== initial[i]?.label);
  const valid = rows.length >= 2 && rows.every((r) => r.label.trim() !== "");

  function setLabel(i: number, label: string) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, label } : r)));
  }
  function move(i: number, dir: -1 | 1) {
    setRows((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }
  function remove(i: number) {
    setRows((prev) => prev.filter((_, j) => j !== i));
  }
  function add() {
    setRows((prev) => [...prev, { key: "", label: "" }]);
  }

  function onSave() {
    setError(null);
    startSave(async () => {
      try {
        const stages = await updateStatuses(
          rows.map((r) => ({ key: r.key, label: r.label.trim() })),
        );
        setRows(stages.map((s) => ({ key: s.key, label: s.label })));
        toast.success("Workflow saved");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {rows.map((row, i) => (
          <li
            key={row.key || `new-${i}`}
            className="flex items-center gap-2 rounded-md border bg-background p-2"
          >
            <GripVertical className="size-4 shrink-0 text-muted-foreground" />
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                statusDotClassFor(row.key || row.label),
              )}
            />
            <Input
              value={row.label}
              onChange={(e) => setLabel(i, e.target.value)}
              disabled={!canEdit || saving}
              placeholder="Stage name"
              className="h-8"
              aria-label={`Stage ${i + 1}`}
            />
            {canEdit ? (
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => move(i, -1)}
                  disabled={i === 0 || saving}
                  aria-label="Move up"
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => move(i, 1)}
                  disabled={i === rows.length - 1 || saving}
                  aria-label="Move down"
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => remove(i)}
                  disabled={rows.length <= 2 || saving}
                  aria-label={`Remove ${row.label || "stage"}`}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      {canEdit ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={add}
            disabled={saving}
            className="gap-1"
          >
            <Plus className="size-3.5" />
            Add stage
          </Button>
          <div className="flex items-center gap-3 pt-1">
            <Button
              type="button"
              size="sm"
              onClick={onSave}
              disabled={!dirty || !valid || saving}
            >
              {saving ? "Saving…" : "Save workflow"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Removing a stage moves its items to the first stage.
            </p>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </>
      ) : null}
    </div>
  );
}
