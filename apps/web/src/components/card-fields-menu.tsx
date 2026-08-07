"use client";

import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";

import { useBoardPrefs } from "@/app/[org]/[product]/backlog/board-prefs";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { CardFieldDef } from "@/lib/card-fields";

/**
 * Board toolbar control to customize which fields show on a card and which
 * custom field is "featured". Reads and writes the shared board preferences
 * (see {@link useBoardPrefs}), so toggling a field updates the cards instantly
 * while the change persists in the background.
 */
export function CardFieldsMenu({
  catalog,
  customFields,
}: {
  catalog: CardFieldDef[];
  /** Custom fields (key + label) that can be featured. */
  customFields: { key: string; label: string }[];
}) {
  const { cardFields, featured, toggleField, setFeatured } = useBoardPrefs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const chosen = new Set(cardFields);

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Settings2 />
        Card fields
      </Button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-60 rounded-md border bg-background p-3 shadow-md">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Show on cards
          </p>
          <div className="space-y-1.5">
            {catalog.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.has(f.key)}
                  onChange={() => toggleField(f.key)}
                  className="size-3.5"
                />
                {f.label}
              </label>
            ))}
          </div>
          {customFields.length > 0 ? (
            <div className="mt-3 space-y-1.5 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                Featured field
              </p>
              <Select
                value={featured ?? ""}
                onChange={(e) => setFeatured(e.target.value || null)}
                className="h-8 text-xs"
              >
                <option value="">None</option>
                {customFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
