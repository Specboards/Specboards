"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ListChecks, Plus, SquarePen, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { CardsOverride } from "@/components/cards-override";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { updateStageGates } from "@/lib/api-client/workspace-config";
import { statusDotColor } from "@/lib/feature-helpers";
import type { GateField } from "@/lib/gate-fields";
import type { StageGate, StageGateKind } from "@/lib/store/types";

/**
 * One editable gate row. `id` is present for gates that already exist (kept
 * across a save so their per-item completions survive); absent for new ones.
 *
 * A `checklist` row carries a typed label. A `field` row carries the key of the
 * field it requires, and its `label` is a snapshot of that field's name, kept
 * only so a gate pointing at a since-deleted property can still say what it
 * used to mean.
 */
interface Row {
  id?: string;
  kind: StageGateKind;
  fieldKey: string | null;
  label: string;
}

interface Stage {
  key: string;
  label: string;
}

/**
 * Admin editor for stage gates: the exit criteria an item must meet before it
 * can advance forward out of a stage.
 *
 * Two kinds, deliberately side by side in one list rather than in two panels.
 * They answer the same question ("what has to be true before this leaves
 * Ready?") and an admin thinking about that question is not thinking about the
 * mechanism; splitting them would make a stage's criteria something you have to
 * assemble from two places to read.
 *
 * Gates attach to a stage by its key, so they work with both the built-in and
 * custom workflows. Saving reconciles by id, so only gates you remove lose
 * their items' progress.
 */
export function WorkflowGatesEditor({
  stages,
  initial,
  fields,
  canEdit,
  productId,
  overridden,
}: {
  /** Product being configured, or null for the workspace default. */
  productId: string | null;
  /** Whether this product has its own gates rather than inheriting. */
  overridden: boolean;
  /** The workflow stages (excluding `archived`), in board order. */
  stages: Stage[];
  /** The current gates across all stages. */
  initial: StageGate[];
  /** Fields a gate can require: built-ins plus this scope's item properties. */
  fields: GateField[];
  canEdit: boolean;
}) {
  const router = useRouter();

  const initialByStage = useMemo(() => {
    const map: Record<string, Row[]> = {};
    for (const s of stages) map[s.key] = [];
    for (const g of [...initial].sort((a, b) => a.position - b.position)) {
      // Ignore gates whose stage no longer exists (they'll be dropped on save).
      map[g.stageKey]?.push({
        id: g.id,
        kind: g.kind,
        fieldKey: g.fieldKey,
        label: g.label,
      });
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
    rows.every((r) =>
      r.kind === "field" ? Boolean(r.fieldKey) : r.label.trim() !== "",
    ),
  );

  function setRows(stageKey: string, next: Row[]) {
    setByStage((prev) => ({ ...prev, [stageKey]: next }));
  }
  function patchRow(stageKey: string, i: number, patch: Partial<Row>) {
    setRows(
      stageKey,
      (byStage[stageKey] ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)),
    );
  }
  function setFieldKey(stageKey: string, i: number, fieldKey: string) {
    // The label follows the picked field, so a gate whose property is later
    // deleted still knows what it was called.
    patchRow(stageKey, i, {
      fieldKey,
      label: fields.find((f) => f.key === fieldKey)?.label ?? fieldKey,
    });
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
  function add(stageKey: string, kind: StageGateKind) {
    // A new field row starts on the first field that this stage does not
    // already require, so adding two in a row does not produce a duplicate the
    // admin then has to notice and change.
    const taken = new Set(
      (byStage[stageKey] ?? []).filter((r) => r.kind === "field").map((r) => r.fieldKey),
    );
    const first = fields.find((f) => !taken.has(f.key)) ?? fields[0];
    setRows(stageKey, [
      ...(byStage[stageKey] ?? []),
      kind === "field"
        ? { kind, fieldKey: first?.key ?? "", label: first?.label ?? "" }
        : { kind, fieldKey: null, label: "" },
    ]);
  }

  function onSave() {
    setError(null);
    startSave(async () => {
      try {
        const payload = stages.flatMap((s) =>
          (byStage[s.key] ?? []).map((r) => ({
            id: r.id,
            stageKey: s.key,
            kind: r.kind,
            fieldKey: r.kind === "field" ? r.fieldKey : null,
            label: r.label.trim(),
          })),
        );
        // Carry through any gates on stages this editor doesn't display (e.g. a
        // stage removed from the workflow) so a wholesale replace doesn't
        // silently delete them and their completions.
        const managed = new Set(stages.map((s) => s.key));
        const passthrough = initial
          .filter((g) => !managed.has(g.stageKey))
          .map((g) => ({
            id: g.id,
            stageKey: g.stageKey,
            kind: g.kind,
            fieldKey: g.fieldKey,
            label: g.label,
          }));
        const gates = await updateStageGates(
          [...payload, ...passthrough],
          productId,
        );
        // Re-seed state from the server so new gates pick up their ids.
        const next: Record<string, Row[]> = {};
        for (const s of stages) next[s.key] = [];
        for (const g of [...gates].sort((a, b) => a.position - b.position)) {
          next[g.stageKey]?.push({
            id: g.id,
            kind: g.kind,
            fieldKey: g.fieldKey,
            label: g.label,
          });
        }
        setByStage(next);
        toast.success("Stage gates saved");
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  const builtinFields = fields.filter((f) => f.group === "Built-in");
  const customFields = fields.filter((f) => f.group === "Custom properties");

  return (
    <CardsOverride
      productId={productId}
      overridden={overridden}
      canEdit={canEdit}
      label="stage gates"
      onOverride={() =>
        // Copy the inherited gates onto the product so overriding starts from
        // what it already enforced rather than from nothing.
        updateStageGates(
          initial.map((g) => ({
            stageKey: g.stageKey,
            kind: g.kind,
            fieldKey: g.fieldKey,
            label: g.label,
          })),
          productId,
        ).then(() => undefined)
      }
      onRevert={() => updateStageGates([], productId).then(() => undefined)}
    >
      <div className="space-y-4">
        <ol className="space-y-4">
          {stages.map((stage) => {
            const rows = byStage[stage.key] ?? [];
            return (
              <li
                key={stage.key}
                className="rounded-md border bg-background p-3"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: statusDotColor(stage.key) }}
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
                        {row.kind === "field" ? (
                          <>
                            <SquarePen
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                            <Select
                              value={row.fieldKey ?? ""}
                              onChange={(e) =>
                                setFieldKey(stage.key, i, e.target.value)
                              }
                              disabled={!canEdit || saving}
                              className="h-8"
                              aria-label={`${stage.label} required field ${i + 1}`}
                            >
                              {/* A gate whose property has since been deleted
                                  keeps its key selectable, so re-saving the
                                  page does not silently rewrite it to whatever
                                  happens to be first in the list. */}
                              {row.fieldKey &&
                              !fields.some((f) => f.key === row.fieldKey) ? (
                                <option value={row.fieldKey}>
                                  {row.label} (no longer exists)
                                </option>
                              ) : null}
                              <optgroup label="Built-in">
                                {builtinFields.map((f) => (
                                  <option key={f.key} value={f.key}>
                                    {f.label}
                                  </option>
                                ))}
                              </optgroup>
                              {customFields.length > 0 ? (
                                <optgroup label="Custom properties">
                                  {customFields.map((f) => (
                                    <option key={f.key} value={f.key}>
                                      {f.label}
                                    </option>
                                  ))}
                                </optgroup>
                              ) : null}
                            </Select>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              must be set
                            </span>
                          </>
                        ) : (
                          <>
                            <ListChecks
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                            <Input
                              value={row.label}
                              onChange={(e) =>
                                patchRow(stage.key, i, { label: e.target.value })
                              }
                              disabled={!canEdit || saving}
                              placeholder="Checklist item"
                              className="h-8"
                              aria-label={`${stage.label} gate ${i + 1}`}
                            />
                          </>
                        )}
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
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => add(stage.key, "checklist")}
                      disabled={saving}
                      className="gap-1"
                    >
                      <Plus className="size-3.5" />
                      Add checklist item
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => add(stage.key, "field")}
                      disabled={saving || fields.length === 0}
                      className="gap-1"
                    >
                      <Plus className="size-3.5" />
                      Require a field
                    </Button>
                  </div>
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
    </CardsOverride>
  );
}
