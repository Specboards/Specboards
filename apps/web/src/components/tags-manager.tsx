"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { tagKey, type TagDef } from "@specboards/core";

import { EmptyState } from "@/components/empty-state";
import { TagImportPanel } from "@/components/tag-import-panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import {
  createTag,
  deleteTag,
  deleteTags,
  renameTag,
} from "@/lib/api-client/tags";

/** Above this many tags the list gets a filter box; below it, one is clutter. */
const FILTER_THRESHOLD = 8;

/**
 * Settings -> Tags: the workspace's tag registry.
 *
 * Renaming is the operation this list exists for. Before the registry a tag was
 * a string inside a thousand arrays, so fixing a typo meant a data migration
 * and there was nothing recording that the old and new spellings were the same
 * tag. Renaming here rewrites the tag on every item that carries it, in one
 * transaction.
 *
 * Deleting only removes the definition. Item values stay where they are, the
 * same bargain custom properties make: re-adding the tag brings them back, and
 * an admin tidying this list must not silently delete other people's work. The
 * bulk delete is deliberately no more destructive than the single one.
 *
 * Rows show the name as text with an Edit control rather than sitting open as
 * inputs. That is the settings convention in CLAUDE.md, and here it also frees
 * the row's left edge for the selection checkbox: a list of open text fields
 * with checkboxes beside them reads as a form, not as a list you are picking
 * from.
 */
export function TagsManager({
  tags,
  canEdit,
}: {
  tags: TagDef[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const visible = useMemo(() => {
    const needle = tagKey(query);
    if (needle === "") return tags;
    return tags.filter((t) => tagKey(t.name).includes(needle));
  }, [tags, query]);

  // Selection is kept across a filter change but only ever acted on for tags
  // still on screen, so narrowing the filter can never delete something the
  // admin has stopped looking at.
  const selectedVisible = visible.filter((t) => selected.has(t.id));
  const allVisibleSelected =
    visible.length > 0 && selectedVisible.length === visible.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const tag of visible) {
        if (allVisibleSelected) next.delete(tag.id);
        else next.add(tag.id);
      }
      return next;
    });
  }

  function onBulkDelete() {
    const ids = selectedVisible.map((t) => t.id);
    const names = selectedVisible.map((t) => t.name);
    if (
      !window.confirm(
        `Remove ${ids.length} ${ids.length === 1 ? "tag" : "tags"} from the registry?\n\n${names.slice(0, 10).join(", ")}${names.length > 10 ? `, and ${names.length - 10} more` : ""}\n\nItems keep the tags they already have, but these disappear from the picker and the filters.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        const result = await deleteTags(ids);
        setSelected(new Set());
        if (result.failCount > 0) {
          toast.warning(
            `Removed ${result.okCount}. ${result.failCount} could not be removed.`,
          );
        } else {
          toast.success(
            `Removed ${result.okCount} ${result.okCount === 1 ? "tag" : "tags"}`,
          );
        }
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  if (tags.length === 0 && !adding && !importing) {
    return (
      <div className="max-w-2xl space-y-4">
        <EmptyState
          variant="inline"
          title="No tags yet"
          description="Tags are shared across the whole workspace, so the same tag can't be spelled two ways and they aren't tied to a product. Anyone can add one from a card; this is where they're renamed, retired, and bulk-loaded."
          action={
            canEdit ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setAdding(true)}>
                  Add tag
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setImporting(true)}
                >
                  Bulk upload
                </Button>
              </div>
            ) : null
          }
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      {tags.length > FILTER_THRESHOLD ? (
        <Input
          type="search"
          value={query}
          aria-label="Filter tags"
          placeholder={`Filter ${tags.length} tags…`}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8"
        />
      ) : null}

      {canEdit && visible.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={allVisibleSelected}
            onClick={toggleAll}
            className="flex items-center gap-2 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Checkbox checked={allVisibleSelected} />
            {allVisibleSelected ? "Clear selection" : "Select all"}
            {query.trim() !== "" ? " shown" : null}
          </button>
          {/* The bar appears with the selection rather than sitting empty, so
              the destructive control is never on screen with nothing chosen. */}
          {selectedVisible.length > 0 ? (
            <div
              role="status"
              className="ml-auto flex items-center gap-2 text-xs"
            >
              <span className="text-muted-foreground">
                {selectedVisible.length} selected
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onBulkDelete}
                disabled={pending}
              >
                <Trash2 aria-hidden />
                {pending ? "Removing…" : "Remove"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {visible.length > 0 ? (
        <ul className="space-y-2">
          {visible.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              canEdit={canEdit}
              selected={selected.has(tag.id)}
              onToggle={() => toggle(tag.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No tag matches “{query}”.
        </p>
      )}

      {/* Both "add" experiences start as an affordance and reveal their fields
          on opt-in (see the "add" UX rule in CLAUDE.md). */}
      {canEdit && adding ? <TagCreate onDone={() => setAdding(false)} /> : null}
      {canEdit && importing ? (
        <TagImportPanel onDone={() => setImporting(false)} />
      ) : null}
      {canEdit && !adding && !importing ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add tag
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImporting(true)}
          >
            Bulk upload
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TagRow({
  tag,
  canEdit,
  selected,
  onToggle,
}: {
  tag: TagDef;
  canEdit: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [pending, startTransition] = useTransition();
  const dirty = name.trim() !== tag.name;

  function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || name.trim() === "") return;
    startTransition(async () => {
      try {
        await renameTag(tag.id, name.trim());
        setEditing(false);
        toast.success("Tag renamed on every item that used it");
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Rename failed.");
      }
    });
  }

  function onDelete() {
    if (
      !window.confirm(
        `Remove the "${tag.name}" tag? Items keep the tag they already have, but it disappears from the picker and the filters.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await deleteTag(tag.id);
        toast.success("Tag removed");
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <button
            type="button"
            aria-pressed={selected}
            aria-label={`Select ${tag.name}`}
            onClick={onToggle}
            className="rounded p-0.5 hover:bg-muted"
          >
            <Checkbox checked={selected} />
          </button>
        ) : null}

        {editing ? (
          <form onSubmit={onSave} className="flex flex-1 flex-wrap gap-2">
            <Input
              autoFocus
              value={name}
              aria-label={`Name of tag ${tag.name}`}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
              className="h-8 min-w-40 flex-1"
            />
            <Button
              type="submit"
              size="sm"
              disabled={pending || !dirty || name.trim() === ""}
            >
              {pending ? "Renaming…" : "Rename"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(tag.name);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-sm">{tag.name}</span>
            {canEdit ? (
              <div className="ml-auto flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Rename ${tag.name}`}
                  onClick={() => setEditing(true)}
                  disabled={pending}
                >
                  <Pencil aria-hidden />
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${tag.name}`}
                  onClick={onDelete}
                  disabled={pending}
                >
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

function TagCreate({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = name.trim();
    if (value === "") return;
    startTransition(async () => {
      try {
        await createTag(value);
        onDone();
        setName("");
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Could not add tag.");
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1 space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Name</span>
        <Input
          autoFocus
          value={name}
          placeholder="area:web"
          onChange={(e) => setName(e.target.value)}
          className="h-8"
        />
      </label>
      <Button type="submit" size="sm" disabled={pending || name.trim() === ""}>
        {pending ? "Adding…" : "Add tag"}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}
