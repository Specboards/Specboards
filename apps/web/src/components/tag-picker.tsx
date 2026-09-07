"use client";

import { useId, useState } from "react";

import { X } from "lucide-react";

import { normalizeTagName, tagKey } from "@specboards/core";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The tag editor on an item's property block.
 *
 * Replaces a single comma-separated text input. That input was the reason
 * `area:web`, `Area:Web` and `area:web ` could all exist at once: it took
 * whatever was typed and there was nothing to compare it against. This offers
 * the workspace's registry first, so the common act is picking an existing tag
 * rather than retyping it and hoping.
 *
 * Typing a name that does not exist still works, because that is a stated
 * requirement: the registry constrains how a tag is *spelled*, not what
 * vocabulary a team is allowed. A new name is created on save by the server
 * (see `resolveTags`), so this does not need to write anything itself, and a
 * card edit that is abandoned leaves no orphan tag behind.
 *
 * The value round-trips through a hidden input rather than being lifted into
 * the parent form's state, so the surrounding autosave keeps serializing the
 * whole form with `FormData` exactly as it did. Comma-joined, which is safe
 * because a comma in a tag name is refused (`tagNameError`) for precisely this
 * reason.
 */
export function TagPicker({
  name,
  value,
  options,
  onCommit,
}: {
  /** Form field name; the joined value is submitted under it. */
  name: string;
  value: string[];
  /** The workspace's registry, in display order. */
  options: string[];
  /** Called with the new list after any change, so the form can save. */
  onCommit: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const listId = useId();

  const chosen = new Set(value.map(tagKey));
  const suggestions = options.filter((o) => !chosen.has(tagKey(o)));
  const draftName = normalizeTagName(draft);
  const isNew =
    draftName !== "" && !options.some((o) => tagKey(o) === tagKey(draftName));

  function add(raw: string) {
    const next = normalizeTagName(raw);
    setDraft("");
    if (next === "") return;
    // Already on this item: silently a no-op rather than an error. Picking the
    // same tag twice is a slip, not a thing to be told off for.
    if (chosen.has(tagKey(next))) return;
    // Show the registry's spelling on the chip, so what the card displays now
    // is what the server will store. Otherwise typing "Area:Web" would show a
    // chip that quietly changed to "area:web" on the next render.
    const canonical = options.find((o) => tagKey(o) === tagKey(next)) ?? next;
    onCommit([...value, canonical]);
  }

  function remove(tag: string) {
    onCommit(value.filter((t) => t !== tag));
  }

  return (
    // No horizontal padding: the chips and the "Add tags" affordance carry
    // their own, so the row starts on the same left edge as the selects above
    // it rather than a padding's width to their right.
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 py-1">
      {/* What the surrounding form serializes. Not `disabled`, or FormData
          would drop it and every save would clear the item's tags. */}
      <input type="hidden" name={name} value={value.join(",")} />

      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-xs"
        >
          {tag}
          <button
            type="button"
            onClick={() => remove(tag)}
            aria-label={`Remove tag ${tag}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}

      {adding ? (
        <span className="inline-flex items-center gap-1">
          <Input
            autoFocus
            list={listId}
            value={draft}
            placeholder="Find or create…"
            aria-label="Tag name"
            className="h-7 w-40 text-xs"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter must not submit the surrounding form: that form is the
              // whole property block, and submitting it would save every field
              // on the card as a side effect of adding one tag.
              if (e.key === "Enter") {
                e.preventDefault();
                add(draft);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft("");
                setAdding(false);
                return;
              }
              // Comma is the separator the old editor used, and muscle memory
              // outlives a UI change. Treat it as "finish this tag".
              if (e.key === ",") {
                e.preventDefault();
                add(draft);
              }
            }}
          />
          {/* A datalist rather than a bespoke popover: it is keyboard and
              screen-reader native, it filters as you type for free, and it
              cannot end up rendered underneath the flyout the way an
              absolutely-positioned menu can. */}
          <datalist id={listId}>
            {suggestions.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draftName === ""}
            onClick={() => add(draft)}
          >
            {isNew ? `Create "${draftName}"` : "Add"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft("");
              setAdding(false);
            }}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          // px-3 rather than the sm size's px-2.5, so the label sits on the
          // same 0.75rem inset as a select's text.
          className="px-3 text-muted-foreground"
          onClick={() => setAdding(true)}
        >
          {value.length === 0 ? "Add tags" : "Add"}
        </Button>
      )}
    </div>
  );
}
