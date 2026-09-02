"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AuthRequiredError } from "@/lib/api-client/request";
import { updateTransitionMode } from "@/lib/api-client/workspace-config";
import type {
  TransitionMode,
  TransitionModeSettings,
  WorkspaceStatus,
} from "@/lib/store/types";

/** A product's "no opinion of my own" choice, distinct from strict/flexible. */
const INHERIT = "inherit";

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
 * Which product this is configuring comes from the page, not from a picker of
 * its own: every panel on Settings > Cards edits the same scope, and one
 * control saying so beats six saying it separately.
 *
 * A product shows an explicit "Inherit" option rather than the mode it happens
 * to be inheriting, so following the workspace stays visibly different from
 * being set to the same thing, and a product that reverts keeps following the
 * default when it next changes.
 *
 * Worth stating in the UI rather than only in docs: stage gates apply in both
 * modes, so choosing Flexible loosens sequencing without giving up the
 * checklists that hold work back.
 */
export function TransitionModeEditor({
  initial,
  productId,
  stages,
  canEdit,
}: {
  /** Every mode configured in the workspace: the default, plus any overrides. */
  initial: TransitionModeSettings;
  /** Product being configured, or null for the workspace default. */
  productId: string | null;
  /** The effective stages, used to phrase the strict option concretely. */
  stages: WorkspaceStatus[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<TransitionModeSettings>(initial);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // `useState(initial)` seeds once and then ignores the prop, so the radio kept
  // showing whatever was last clicked even after `router.refresh()` brought back
  // a server value that disagreed. A save that did not persist therefore looked
  // like it had, until the next full page load. Re-syncing during render (the
  // documented pattern for deriving state from props) means the control always
  // shows what the server actually stored.
  const [serverSettings, setServerSettings] =
    useState<TransitionModeSettings>(initial);
  if (initial !== serverSettings) {
    setServerSettings(initial);
    setSettings(initial);
  }

  const editingDefault = productId === null;

  // What the radios show: a product with no override of its own displays
  // "Inherit", not the mode it happens to be inheriting.
  const selected: TransitionMode | typeof INHERIT = editingDefault
    ? settings.workspaceDefault
    : (settings.overrides[productId] ?? INHERIT);

  function choose(next: TransitionMode | typeof INHERIT) {
    if (next === selected || !canEdit) return;
    const previous = settings;
    const mode = next === INHERIT ? null : next;

    // Optimistic, then reconciled from the server's answer below: reverting to
    // Inherit resolves to whatever is inherited, which the client cannot assume.
    setSettings((s) => {
      if (editingDefault) {
        return { ...s, workspaceDefault: next as TransitionMode };
      }
      const overrides = { ...s.overrides };
      if (mode === null) delete overrides[productId];
      else overrides[productId] = mode;
      return { ...s, overrides };
    });
    setError(null);

    startSave(async () => {
      try {
        const effective = await updateTransitionMode(mode, productId);
        toast.success(
          mode === null
            ? `Now following the workspace default: ${effective === "flexible" ? "any stage can move to any other" : "items move one stage at a time"}.`
            : mode === "flexible"
              ? "Any stage can now move to any other."
              : "Items now move one stage at a time.",
        );
        router.refresh();
      } catch (err) {
        setSettings(previous);
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

  const inheritedLabel =
    settings.workspaceDefault === "flexible" ? "Flexible" : "Strict";

  return (
    <div className="space-y-3">
      <fieldset className="space-y-2" disabled={!canEdit || saving}>
        <legend className="sr-only">Transitions</legend>
        {!editingDefault ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-brand has-[:disabled]:cursor-default">
            <input
              type="radio"
              name="transitionMode"
              value={INHERIT}
              checked={selected === INHERIT}
              onChange={() => choose(INHERIT)}
              className="mt-0.5 accent-primary"
            />
            <span className="space-y-0.5">
              <span className="block font-medium">
                Inherit ({inheritedLabel})
              </span>
              <span className="block text-xs text-muted-foreground">
                Follow the workspace default, including if someone changes it
                later.
              </span>
            </span>
          </label>
        ) : null}
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-brand has-[:disabled]:cursor-default"
          >
            <input
              type="radio"
              name="transitionMode"
              value={option.value}
              checked={selected === option.value}
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
          Stage gates apply in both modes: a forward move still has to satisfy
          the checklists of every stage it passes over.
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </fieldset>
    </div>
  );
}
