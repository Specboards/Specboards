"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AuthRequiredError, updateTransitionMode } from "@/lib/api-client";
import { Select } from "@/components/ui/select";
import type {
  ProductRecord,
  TransitionMode,
  TransitionModeSettings,
  WorkspaceStatus,
} from "@/lib/store/types";

/** The workspace default, as a `<Select>` value that cannot collide with a uuid. */
const DEFAULT_SCOPE = "";

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
 * The setting is configured per product, so the control first asks *what* is
 * being configured: the workspace default, or one product. A product starts out
 * inheriting the default and can take its own line; reverting is an explicit
 * "Inherit" choice rather than a delete, so nothing about the product is lost
 * when it goes back to following the workspace.
 *
 * The scope picker only appears once there is more than one product, since with
 * one product a default and an override are the same sentence said twice.
 *
 * Worth stating in the UI rather than only in docs: stage gates apply in both
 * modes, so choosing Flexible loosens sequencing without giving up the
 * checklists that hold work back.
 */
export function TransitionModeEditor({
  initial,
  products,
  stages,
  canEditDefault,
  manageableProductIds,
}: {
  /** Every mode configured in the workspace: the default, plus any overrides. */
  initial: TransitionModeSettings;
  /** Products the viewer can see, for the scope picker. */
  products: ProductRecord[];
  /** The effective stages, used to phrase the strict option concretely. */
  stages: WorkspaceStatus[];
  /** Whether the viewer may change the workspace default (owner only). */
  canEditDefault: boolean;
  /** Products the viewer may configure (product admin, or workspace owner). */
  manageableProductIds: string[];
}) {
  const router = useRouter();
  const [scope, setScope] = useState<string>(DEFAULT_SCOPE);
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

  const manageable = new Set(manageableProductIds);
  const editingDefault = scope === DEFAULT_SCOPE;
  const canEdit = editingDefault ? canEditDefault : manageable.has(scope);

  // What the radios show: a product with no override of its own displays
  // "Inherit", not the mode it happens to be inheriting, so the difference
  // between "following the workspace" and "set to the same thing" stays visible.
  const selected: TransitionMode | typeof INHERIT = editingDefault
    ? settings.workspaceDefault
    : (settings.overrides[scope] ?? INHERIT);

  function choose(next: TransitionMode | typeof INHERIT) {
    if (next === selected || !canEdit) return;
    const previous = settings;
    const productId = editingDefault ? null : scope;
    const mode = next === INHERIT ? null : next;

    // Optimistic, then reconciled from the server's answer below: reverting to
    // Inherit resolves to whatever is inherited, which the client cannot assume.
    setSettings((s) => {
      if (editingDefault) return { ...s, workspaceDefault: next as TransitionMode };
      const overrides = { ...s.overrides };
      if (mode === null) delete overrides[scope];
      else overrides[scope] = mode;
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
      {products.length > 1 ? (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Configuring</span>
          <Select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setError(null);
            }}
            className="h-8 w-auto min-w-56"
            disabled={saving}
          >
            <option value={DEFAULT_SCOPE}>
              Workspace default (all products)
            </option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {settings.overrides[p.id] ? "" : " (inherited)"}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

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
        {!canEdit && products.length > 1 ? (
          <p className="text-xs text-muted-foreground">
            {editingDefault
              ? "Only the workspace owner can change the default."
              : "You need to be an admin of this product to change it."}
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </fieldset>
    </div>
  );
}
