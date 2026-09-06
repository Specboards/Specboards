"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { TagDef } from "@specboards/core";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { createTag, deleteTag, renameTag } from "@/lib/api-client/tags";

/**
 * Settings -> Cards: the workspace's tag registry.
 *
 * Renaming is the operation this list exists for. Before the registry a tag was
 * a string inside a thousand arrays, so fixing a typo meant a data migration
 * and there was nothing recording that the old and new spellings were the same
 * tag. Renaming here rewrites the tag on every item that carries it, in one
 * transaction.
 *
 * Deleting only removes the definition. Item values stay where they are, the
 * same bargain custom properties make: re-adding the tag brings them back, and
 * an admin tidying this list must not silently delete other people's work.
 */
export function TagsManager({
  tags,
  canEdit,
}: {
  tags: TagDef[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="max-w-2xl space-y-4">
      {tags.length === 0 && !adding ? (
        <EmptyState
          variant="inline"
          title="No tags yet"
          description="Tags are shared across the workspace, so the same tag can't be spelled two ways. Anyone can add one from a card; this is where they're renamed and retired."
          action={
            canEdit ? (
              <Button size="sm" onClick={() => setAdding(true)}>
                Add tag
              </Button>
            ) : null
          }
        />
      ) : null}

      {tags.length > 0 ? (
        <div className="space-y-2">
          {tags.map((tag) => (
            <TagRow key={tag.id} tag={tag} canEdit={canEdit} />
          ))}
        </div>
      ) : null}

      {/* Start as an "Add tag" affordance; reveal the form on opt-in (see the
          "add" UX rule in CLAUDE.md). */}
      {canEdit && adding ? (
        <TagCreate onDone={() => setAdding(false)} />
      ) : null}
      {canEdit && !adding && tags.length > 0 ? (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          Add tag
        </Button>
      ) : null}
    </div>
  );
}

function TagRow({ tag, canEdit }: { tag: TagDef; canEdit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(tag.name);
  const [pending, startTransition] = useTransition();
  const dirty = name.trim() !== tag.name;

  function onSave() {
    startTransition(async () => {
      try {
        await renameTag(tag.id, name.trim());
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
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
      <Input
        value={name}
        aria-label={`Name of tag ${tag.name}`}
        onChange={(e) => setName(e.target.value)}
        disabled={!canEdit || pending}
        className="h-8 min-w-40 flex-1"
      />
      {canEdit ? (
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={pending || !dirty || name.trim() === ""}
          >
            Rename
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
