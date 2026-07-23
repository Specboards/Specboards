"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthRequiredError, updateStageGates } from "@/lib/api-client";
import { statusDotClassFor } from "@/lib/feature-helpers";
import { cn } from "@/lib/utils";
import type { StageGate } from "@/lib/store/types";

/** One editable gate row. `id` is present for gates that already exist (kept
 *  across a save so their per-item completions survive); absent for new ones. */
interface Row {
  id?: string;
  label: string;
}

interface Stage {
  key: string;
  label: string;
}

/**
 * Admin editor for stage gates: per-stage checklists an item must complete
 * before it can advance forward. Gates attach to a stage by its key, so they
 * work with both the built-in and custom workflows. Saving reconciles by id, so
 * only gates you remove lose their items' progress.
 */
export function WorkflowGatesEditor({
  stages,
  initial,
  canEdit,
}: {
  /** The workflow stages (excluding `archived`), in board order. */
  stages: Stage[];
  /** The current gates across all stages. */
  initial: StageGate[];
  canEdit: boolean;
}) {
  const router = useRouter();

  const initialByStage = useMemo(() => {
    const map: Record<string, Row[]> = {};
    for (const s of stages) map[s.key] = [];
    for (const g of [...initial].sort((a, b) => a.position - b.position)) {
      // Ignore gates whose stage no longer exists (they'll be dropped on save).
      map[g.stageKey]?.push({ id: g.id, label: g.label });
    }
    return map;
  }, [stages, initial]);

  const [byStage, setByStage] = useState<Record<string, Row[]>>(initialByStage);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(byStage) !== JSON.stringify(initialByStage),
    [byStage, initialByStage],
  );
  const valid = Object.values(byStage).every((rows) =>
    rows.every((r) => r.label.trim() !== ""),
  );

  function setRows(stageKey: string, next: Row[]) {
    setByStage((prev) => ({ ...prev, [stageKey]: next }));
  }
  function setLabel(stageKey: string, i: number, label: string) {
    setRows(
      stageKey,
      (byStage[stageKey] ?? []).map((r, j) => (j === i ? { ...r, label } : r)),
    );
  }
  function move(stageKey: string, i: number, dir: -1 | 1) {
    const rows = byStage[stageKey] ?? [];
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    setRows(stageKey, next);
  }
  function remove(stageKey: string, i: number) {
    setRows(
      stageKey,
      (byStage[stageKey] ?? []).filter((_, j) => j !== i),
    );
  }
  function add(stageKey: string) {
    setRows(stageKey, [...(byStage[stageKey] ?? []), { label: "" }]);
  }

  function onSave() {
    setError(null);
    startSave(async () => {
      try {
        const payload = stages.flatMap((s) =>
          (byStage[s.key] ?? []).map((r) => ({
            id: r.id,
            stageKey: s.key,
            label: r.label.trim(),
          })),
        );
        // Carry through any gates on stages this editor doesn't display (e.g. a
        // stage removed from the workflow) so a wholesale replace doesn't
        // silently delete them and their completions.
        const managed = new Set(stages.map((s) => s.key));
        const passthrough = initial
          .filter((g) => !managed.has(g.stageKey))
          .map((g) => ({ id: g.id, stageKey: g.stageKey, label: g.label }));
        const gates = await updateStageGates([...payload, ...passthrough]);
        // Re-seed state from the server so new gates pick up their ids.
        const next: Record<string, Row[]> = {};
        for (const s of stages) next[s.key] = [];
        for (const g of [...gates].sort((a, b) => a.position - b.position)) {
          next[g.stageKey]?.push({ id: g.id, label: g.label });
        }
        setByStage(next);
        toast.success("Stage gates saved");
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
    <div className="space-y-4">
      <ol className="space-y-4">
        {stages.map((stage) => {
          const rows = byStage[stage.key] ?? [];
          return (
            <li key={stage.key} className="rounded-md border bg-background p-3">
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={cn(
                    "size-2.5 shrink-0 rounded-full",
                    statusDotClassFor(stage.key),
                  )}
                />
                <span className="text-sm font-medium">{stage.label}</span>
                <span className="text-xs text-muted-foreground">
                  {rows.length === 0
                    ? "no gates"
                    : `${rows.length} gate${rows.length === 1 ? "" : "s"}`}
                </span>
              </div>

              {rows.length > 0 ? (
                <ul className="mb-2 space-y-1.5">
                  {rows.map((row, i) => (
                    <li
                      key={row.id ?? `new-${i}`}
                      className="flex items-center gap-2"
                    >
                      <Input
                        value={row.label}
                        onChange={(e) => setLabel(stage.key, i, e.target.value)}
                        disabled={!canEdit || saving}
                        placeholder="Checklist item"
                        className="h-8"
                        aria-label={`${stage.label} gate ${i + 1}`}
                      />
                      {canEdit ? (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            onClick={() => move(stage.key, i, -1)}
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
                            onClick={() => move(stage.key, i, 1)}
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
                            onClick={() => remove(stage.key, i)}
                            disabled={saving}
                            aria-label="Remove gate"
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {canEdit ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => add(stage.key)}
                  disabled={saving}
                  className="gap-1"
                >
                  <Plus className="size-3.5" />
                  Add checklist item
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>

      {canEdit ? (
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              onClick={onSave}
              disabled={!dirty || !valid || saving}
            >
              {saving ? "Saving…" : "Save stage gates"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Removing a gate clears items&apos; progress on it.
            </p>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
