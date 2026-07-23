"use client";

import { useState } from "react";
import { ListChecks } from "lucide-react";
import { toast } from "sonner";

import { AuthRequiredError, setGateCompletion } from "@/lib/api-client";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { StageGate } from "@/lib/store/types";

/**
 * The exit-criteria checklist for the item's current stage. Members check gates
 * off; every gate must be complete before the item can advance to a later
 * stage (the server hard-blocks the move otherwise). Renders nothing when the
 * current stage has no gates.
 */
export function GateChecklist({
  specId,
  stageLabel,
  gates,
  completedGateIds,
  canEdit,
}: {
  specId: string;
  /** Display label of the current stage, for the heading. */
  stageLabel: string;
  gates: StageGate[];
  completedGateIds: string[];
  canEdit: boolean;
}) {
  const [done, setDone] = useState<Set<string>>(
    () => new Set(completedGateIds),
  );
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  if (gates.length === 0) return null;

  const remaining = gates.filter((g) => !done.has(g.id)).length;
  const allDone = remaining === 0;

  async function toggle(gate: StageGate) {
    if (!canEdit || pending.has(gate.id)) return;
    const next = !done.has(gate.id);
    // Optimistic: flip immediately, roll back on failure.
    setDone((prev) => {
      const s = new Set(prev);
      if (next) s.add(gate.id);
      else s.delete(gate.id);
      return s;
    });
    setPending((prev) => new Set(prev).add(gate.id));
    try {
      // Keep the optimistic flip; don't overwrite the whole set from the server
      // response, which would clobber another toggle still in flight.
      await setGateCompletion(specId, gate.id, next);
    } catch (err) {
      // Roll back the optimistic flip.
      setDone((prev) => {
        const s = new Set(prev);
        if (next) s.delete(gate.id);
        else s.add(gate.id);
        return s;
      });
      if (err instanceof AuthRequiredError) {
        toast.error("Please sign in again.");
      } else {
        toast.error(err instanceof Error ? err.message : "Could not update gate.");
      }
    } finally {
      setPending((prev) => {
        const s = new Set(prev);
        s.delete(gate.id);
        return s;
      });
    }
  }

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2">
        <ListChecks className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{stageLabel} checklist</h3>
        <span
          className={cn(
            "ml-auto text-xs",
            allDone ? "text-success-fg" : "text-muted-foreground",
          )}
        >
          {allDone ? (
            "Ready to advance"
          ) : (
            <>
              <span className="font-mono">
                {gates.length - remaining}/{gates.length}
              </span>{" "}
              complete
            </>
          )}
        </span>
      </div>
      <ul className="space-y-1">
        {gates.map((gate) => {
          const checked = done.has(gate.id);
          return (
            <li key={gate.id}>
              <button
                type="button"
                onClick={() => toggle(gate)}
                disabled={!canEdit || pending.has(gate.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm",
                  canEdit && "hover:bg-muted disabled:opacity-60",
                  !canEdit && "cursor-default",
                )}
                aria-pressed={checked}
              >
                <Checkbox checked={checked} />
                <span
                  className={cn(
                    checked && "text-muted-foreground line-through",
                  )}
                >
                  {gate.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!allDone ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Complete every item to move this out of {stageLabel}.
        </p>
      ) : null}
    </div>
  );
}
