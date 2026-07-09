"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AuthRequiredError, updateLevelFields } from "@/lib/api-client";
import type { CardFieldDef } from "@/lib/card-fields";
import type { WorkspaceLevel } from "@/lib/store/types";

/**
 * Settings → Cards: per hierarchy level, which metadata fields items carry.
 * A level with every box checked is stored as null (all fields), so newly
 * added custom fields show up without another visit here.
 */
export function CardsFieldsEditor({
  levels,
  catalog,
  canEdit,
}: {
  levels: WorkspaceLevel[];
  catalog: CardFieldDef[];
  canEdit: boolean;
}) {
  const allKeys = catalog.map((f) => f.key);
  const [checked, setChecked] = useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(
      levels.map((l) => [l.key, new Set(l.fields ?? allKeys)]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(levelKey: string, fieldKey: string) {
    setChecked((prev) => {
      const set = new Set(prev[levelKey] ?? allKeys);
      if (set.has(fieldKey)) set.delete(fieldKey);
      else set.add(fieldKey);
      return { ...prev, [levelKey]: set };
    });
  }

  function onSave() {
    startTransition(async () => {
      setError(null);
      try {
        const fields = Object.fromEntries(
          levels.map((l) => {
            const set = checked[l.key] ?? new Set(allKeys);
            const value =
              allKeys.every((k) => set.has(k))
                ? null
                : allKeys.filter((k) => set.has(k));
            return [l.key, value];
          }),
        );
        await updateLevelFields(fields);
        toast.success("Card fields saved");
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          window.location.href = "/sign-in";
          return;
        }
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-5">
      {levels.map((level) => {
        const set = checked[level.key] ?? new Set(allKeys);
        return (
          <fieldset key={level.key} className="space-y-2 rounded-md border p-4">
            <legend className="px-1 text-sm font-medium">{level.label}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {catalog.map((field) => (
                <label
                  key={field.key}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={set.has(field.key)}
                    disabled={!canEdit}
                    onChange={() => toggle(level.key, field.key)}
                    className="h-4 w-4 rounded border-input"
                  />
                  {field.label}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}

      <p className="text-xs text-muted-foreground">
        Name, status, parent, and release are structural and always available.
        Which of these fields a card displays on the board stays a per-member
        preference.
      </p>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {canEdit ? (
        <Button type="button" size="sm" onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : "Save card fields"}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only the owner can change card fields.
        </p>
      )}
    </div>
  );
}
