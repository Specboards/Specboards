"use client";

import { useRouter } from "next/navigation";

import { useState } from "react";
import { ListChecks } from "lucide-react";
import { toast } from "sonner";

import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { setGateCompletion } from "@/lib/api-client/workspace-config";
import { Checkbox } from "@/components/ui/checkbox";
import type { ResolvedGate } from "@/lib/item-detail";
import { cn } from "@/lib/utils";

/**
 * The exit criteria for the item's current stage. Every one must be met before
 * the item can advance to a later stage (the server hard-blocks the move
 * otherwise). Renders nothing when the current stage has no gates.
 *
 * Two kinds sit in one list, because to the person reading it they are one
 * thing: what is left to do before this can move. They differ in how they are
 * answered, and the row says so.
 *
 * - A **checklist** gate is ticked here. It is a promise, so it stays ticked.
 * - A **field** gate is answered by the item's own data, so it is not tickable.
 *   It ticks itself when the field is filled in above and un-ticks if the value
 *   is later cleared, which is the property that makes it worth having.
 */
export function GateChecklist({
  specId,
  stageLabel,
  gates,
  canEdit,
}: {
  specId: string;
  /** Display label of the current stage, for the heading. */
  stageLabel: string;
  /** The stage's gates, already resolved against this item on the server. */
  gates: ResolvedGate[];
  canEdit: boolean;
}) {
  const router = useRouter();
  // Only checklist gates are tracked locally: a field gate's answer comes from
  // the item's data, which this component does not own and must not guess at.
  const [ticked, setTicked] = useState<Set<string>>(
    () =>
      new Set(
        gates.filter((g) => g.kind !== "field" && g.satisfied).map((g) => g.id),
      ),
  );
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  if (gates.length === 0) return null;

  function isMet(gate: ResolvedGate): boolean {
    return gate.kind === "field" ? gate.satisfied : ticked.has(gate.id);
  }

  const remaining = gates.filter((g) => !isMet(g)).length;
  const allDone = remaining === 0;

  async function toggle(gate: ResolvedGate) {
    if (gate.kind === "field") return;
    if (!canEdit || pending.has(gate.id)) return;
    const next = !ticked.has(gate.id);
    // Optimistic: flip immediately, roll back on failure.
    setTicked((prev) => {
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
      setTicked((prev) => {
        const s = new Set(prev);
        if (next) s.delete(gate.id);
        else s.add(gate.id);
        return s;
      });
      // Was a toast telling the reader to sign in again without taking them
      // anywhere, which is advice they cannot act on from here.
      if (redirectOnAuthExpiry(err, router)) return;
      toast.error(
        err instanceof Error ? err.message : "Could not update gate.",
      );
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
          const met = isMet(gate);
          const isField = gate.kind === "field";
          return (
            <li key={gate.id}>
              <button
                type="button"
                onClick={() => toggle(gate)}
                disabled={isField || !canEdit || pending.has(gate.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  !isField && canEdit && "hover:bg-muted disabled:opacity-60",
                  (isField || !canEdit) && "cursor-default",
                )}
                aria-pressed={isField ? undefined : met}
                // Says why the row does not respond to a click, which is the
                // question somebody asks the first time they meet one.
                title={
                  isField
                    ? met
                      ? `${gate.label} is set on this item.`
                      : `Set ${gate.label} on this item to satisfy this.`
                    : undefined
                }
              >
                <Checkbox checked={met} />
                <span className={cn(met && "text-muted-foreground line-through")}>
                  {gate.label}
                </span>
                {isField ? (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {met ? "field set" : "field required"}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {!allDone ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {gates.some((g) => g.kind === "field" && !g.satisfied)
            ? `Tick every item and fill in every required field to move this out of ${stageLabel}.`
            : `Complete every item to move this out of ${stageLabel}.`}
        </p>
      ) : null}
    </div>
  );
}
