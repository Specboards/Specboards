"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AuthRequiredError, updateTransitionMode } from "@/lib/api-client";
import type { TransitionMode, WorkspaceStatus } from "@/lib/store/types";

const OPTIONS: {
  value: TransitionMode;
  label: string;
  description: (stages: WorkspaceStatus[]) => string;
}[] = [
  {
    value: "strict",
    label: "Strict",
    description: (stages) =>
      stages.length >= 2
        ? `Items move one stage at a time: ${stages[0]!.label} to ${stages[1]!.label}, and so on. They can also step back or be archived.`
        : "Items move one stage at a time. They can also step back or be archived.",
  },
  {
    value: "flexible",
    label: "Flexible",
    description: () =>
      "Any stage can move to any other, so an item can jump straight to where it really is.",
  },
];

/**
 * Admin control for how freely items move between stages. Sits with the stage
 * list because the two only make sense together: the stages are the vocabulary,
 * this is what the board lets you do with it.
 *
 * Worth stating in the UI rather than only in docs: stage gates apply in both
 * modes, so choosing Flexible loosens sequencing without giving up the
 * checklists that hold work back.
 */
export function TransitionModeEditor({
  initial,
  stages,
  canEdit,
}: {
  initial: TransitionMode;
  /** The effective stages, used to phrase the strict option concretely. */
  stages: WorkspaceStatus[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<TransitionMode>(initial);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function choose(next: TransitionMode) {
    if (next === mode || !canEdit) return;
    const previous = mode;
    setMode(next);
    setError(null);
    startSave(async () => {
      try {
        await updateTransitionMode(next);
        toast.success(
          next === "flexible"
            ? "Any stage can now move to any other."
            : "Items now move one stage at a time.",
        );
        router.refresh();
      } catch (err) {
        setMode(previous);
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    });
  }

  return (
    <fieldset className="space-y-2" disabled={!canEdit || saving}>
      <legend className="sr-only">Transitions</legend>
      {OPTIONS.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-brand has-[:disabled]:cursor-default"
        >
          <input
            type="radio"
            name="transitionMode"
            value={option.value}
            checked={mode === option.value}
            onChange={() => choose(option.value)}
            className="mt-0.5 accent-primary"
          />
          <span className="space-y-0.5">
            <span className="block font-medium">{option.label}</span>
            <span className="block text-xs text-muted-foreground">
              {option.description(stages)}
            </span>
          </span>
        </label>
      ))}
      <p className="text-xs text-muted-foreground">
        Stage gates apply in both modes: a forward move still has to satisfy the
        checklists of every stage it passes over.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </fieldset>
  );
}
