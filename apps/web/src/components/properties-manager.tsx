"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { PropertyDef, PropertyEntity, PropertyType } from "@specboards/core";
import { PROPERTY_TYPES } from "@specboards/core";

import { CardsOverride } from "@/components/cards-override";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  AuthRequiredError,
  createProperty,
  deleteProperty,
  updateProperty,
} from "@/lib/api-client";
import type { WorkspaceLevel } from "@/lib/store/types";

const TYPE_LABELS: Record<PropertyType, string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  multiselect: "Multi-select",
  date: "Date",
  user: "Person",
  url: "URL",
};

const ENTITY_LABELS: Record<PropertyEntity, string> = {
  item: "Work items",
  release: "Releases",
};

/**
 * Settings -> Cards: the workspace's custom properties. Admins define a
 * property (label + type + options) and check which hierarchy levels it
 * appears on; values are edited on each item's detail page.
 */
export function PropertiesManager({
  levels,
  properties,
  canEdit,
  productId,
  overridden,
}: {
  /** Product being configured, or null for the workspace default. */
  productId: string | null;
  /** Whether this product has its own properties rather than inheriting. */
  overridden: boolean;
  levels: WorkspaceLevel[];
  properties: PropertyDef[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <CardsOverride
      productId={productId}
      overridden={overridden}
      canEdit={canEdit}
      label="custom properties"
      onOverride={async () => {
        // Copy what the product is inheriting onto the product itself, one
        // definition at a time (there is no bulk create), so overriding starts
        // from the fields people are already filling in rather than a blank
        // list. Values already stored on items keep their keys, so they light
        // straight back up.
        for (const p of properties) {
          await createProperty(
            {
              label: p.label,
              type: p.type,
              options: p.options,
              levels: p.levels,
              entity: p.entity,
            },
            productId,
          );
        }
      }}
      onRevert={async () => {
        // Once overridden, everything listed is the product's own, so this
        // clears exactly what it defined. Item values survive: dropping a
        // definition hides values, it does not delete them.
        for (const p of properties) await deleteProperty(p.id);
      }}
    >
    <div className="max-w-2xl space-y-4">
      {properties.length === 0 && !adding ? (
        <EmptyState
          variant="inline"
          title="No custom properties yet"
          description="Custom properties add fields like Effort or Team to your cards, editable on each item's detail page."
          action={
            canEdit ? (
              <Button size="sm" onClick={() => setAdding(true)}>
                Add property
              </Button>
            ) : null
          }
        />
      ) : null}
      {properties.length > 0 ? (
        <div className="space-y-3">
          {properties.map((property) => (
            <PropertyRow
              key={property.id}
              property={property}
              levels={levels}
              canEdit={canEdit}
            />
          ))}
        </div>
      ) : null}
      {/* Start as an "Add property" affordance; reveal the form on opt-in (see
          the "add" UX rule in CLAUDE.md). */}
      {canEdit && adding ? (
        <PropertyCreate
          levels={levels}
          productId={productId}
          onDone={() => setAdding(false)}
        />
      ) : null}
      {canEdit && !adding && properties.length > 0 ? (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          Add property
        </Button>
      ) : null}
    </div>
    </CardsOverride>
  );
}

/** Per-level availability checkboxes shared by the row editor and creator. */
function LevelChecks({
  levels,
  checked,
  onToggle,
  disabled,
  idPrefix,
}: {
  levels: WorkspaceLevel[];
  checked: Set<string>;
  onToggle: (key: string) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {levels.map((level) => (
        <label
          key={`${idPrefix}:${level.key}`}
          className="flex items-center gap-1.5 text-sm"
        >
          <input
            type="checkbox"
            checked={checked.has(level.key)}
            disabled={disabled}
            onChange={() => onToggle(level.key)}
            className="h-4 w-4 rounded border-input"
          />
          {level.label}
        </label>
      ))}
    </div>
  );
}

/** All levels checked persists as null so future levels auto-include. */
function levelsValue(
  levels: WorkspaceLevel[],
  checked: Set<string>,
): string[] | null {
  return levels.every((l) => checked.has(l.key))
    ? null
    : levels.filter((l) => checked.has(l.key)).map((l) => l.key);
}

function hasOptions(type: PropertyType): boolean {
  return type === "select" || type === "multiselect";
}

function PropertyRow({
  property,
  levels,
  canEdit,
}: {
  property: PropertyDef;
  levels: WorkspaceLevel[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [label, setLabel] = useState(property.label);
  const [options, setOptions] = useState(property.options.join(", "));
  const [checked, setChecked] = useState<Set<string>>(
    () =>
      new Set(
        property.levels === null ? levels.map((l) => l.key) : property.levels,
      ),
  );
  const [pending, startTransition] = useTransition();

  const dirty =
    label.trim() !== property.label ||
    (hasOptions(property.type) && options !== property.options.join(", ")) ||
    JSON.stringify(levelsValue(levels, checked)) !==
      JSON.stringify(property.levels);

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onSave() {
    startTransition(async () => {
      try {
        await updateProperty(property.id, {
          label: label.trim(),
          ...(hasOptions(property.type)
            ? {
                options: options
                  .split(",")
                  .map((o) => o.trim())
                  .filter(Boolean),
              }
            : {}),
          levels: levelsValue(levels, checked),
        });
        toast.success("Property saved");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          window.location.href = "/sign-in";
          return;
        }
        toast.error(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  function onDelete() {
    if (
      !window.confirm(
        `Delete the "${property.label}" property? Items keep their stored values, but the field disappears everywhere.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await deleteProperty(property.id);
        toast.success("Property deleted");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          window.location.href = "/sign-in";
          return;
        }
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Label
          </span>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={!canEdit}
            className="h-8"
          />
        </label>
        <span className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground">
          {TYPE_LABELS[property.type]}
        </span>
        {property.entity === "release" ? (
          <span className="rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">
            Releases
          </span>
        ) : null}
        {canEdit ? (
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={onSave}
              disabled={pending || !dirty || label.trim() === ""}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onDelete}
              disabled={pending}
            >
              Delete
            </Button>
          </div>
        ) : null}
      </div>
      {hasOptions(property.type) ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Options (comma-separated)
          </span>
          <Input
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            disabled={!canEdit}
            className="h-8"
          />
        </label>
      ) : null}
      {property.entity === "release" ? (
        <p className="text-xs text-muted-foreground">
          Applies to every release.
        </p>
      ) : (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Available on
          </span>
          <LevelChecks
            levels={levels}
            checked={checked}
            onToggle={toggle}
            disabled={!canEdit || pending}
            idPrefix={property.id}
          />
        </div>
      )}
    </fieldset>
  );
}

function PropertyCreate({
  productId,
  levels,
  onDone,
}: {
  /** Scope the new property is defined in; null = the workspace default. */
  productId: string | null;
  levels: WorkspaceLevel[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<PropertyType>("text");
  const [entity, setEntity] = useState<PropertyEntity>("item");
  const [options, setOptions] = useState("");
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(levels.map((l) => l.key)),
  );
  const [pending, startTransition] = useTransition();

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onCreate() {
    startTransition(async () => {
      try {
        await createProperty({
          label: label.trim(),
          type,
          entity,
          ...(hasOptions(type)
            ? {
                options: options
                  .split(",")
                  .map((o) => o.trim())
                  .filter(Boolean),
              }
            : {}),
          // Levels only apply to item properties; releases are workspace-wide.
          ...(entity === "item" ? { levels: levelsValue(levels, checked) } : {}),
        }, productId);
        toast.success("Property added");
        setLabel("");
        setType("text");
        setEntity("item");
        setOptions("");
        setChecked(new Set(levels.map((l) => l.key)));
        onDone();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          window.location.href = "/sign-in";
          return;
        }
        toast.error(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  return (
    <fieldset className="space-y-3 rounded-md border border-dashed p-4">
      <legend className="px-1 text-sm font-medium">New property</legend>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Label
          </span>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Effort"
            className="h-8"
            autoFocus
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Type
          </span>
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as PropertyType)}
            className="h-8 w-36"
          >
            {PROPERTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Applies to
          </span>
          <Select
            value={entity}
            onChange={(e) => setEntity(e.target.value as PropertyEntity)}
            className="h-8 w-36"
          >
            {(Object.keys(ENTITY_LABELS) as PropertyEntity[]).map((en) => (
              <option key={en} value={en}>
                {ENTITY_LABELS[en]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {hasOptions(type) ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Options (comma-separated)
          </span>
          <Input
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder="S, M, L"
            className="h-8"
          />
        </label>
      ) : null}
      {entity === "release" ? (
        <p className="text-xs text-muted-foreground">
          Applies to every release. Edit its value on the release detail panel.
        </p>
      ) : (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Available on
          </span>
          <LevelChecks
            levels={levels}
            checked={checked}
            onToggle={toggle}
            disabled={pending}
            idPrefix="new"
          />
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={onCreate}
          disabled={pending || label.trim() === ""}
        >
          {pending ? "Adding…" : "Add property"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDone}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
