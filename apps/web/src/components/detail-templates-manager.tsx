"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { EXAMPLE_DETAIL_TEMPLATES, type DetailTemplate } from "@specboard/core";

import { EmptyState } from "@/components/empty-state";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  AuthRequiredError,
  createDetailTemplate,
  deleteDetailTemplate,
  updateDetailTemplate,
  updateLevelTemplates,
} from "@/lib/api-client";
import type { WorkspaceLevel } from "@/lib/store/types";

/**
 * Settings -> Cards: admin-defined "Details Templates". Each template is a
 * Markdown skeleton that seeds a new card's details; admins can assign one per
 * hierarchy level. Built-in examples give a starting point to copy from.
 */
export function DetailTemplatesManager({
  templates,
  levels,
  canEdit,
}: {
  templates: DetailTemplate[];
  levels: WorkspaceLevel[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="max-w-2xl space-y-4">
      {templates.length === 0 && !adding ? (
        <EmptyState
          variant="inline"
          title="No detail templates yet"
          description="A detail template is a Markdown skeleton that seeds a new card's details, so every card of a kind starts consistent."
          action={
            canEdit ? (
              <Button size="sm" onClick={() => setAdding(true)}>
                Add template
              </Button>
            ) : null
          }
        />
      ) : null}
      {templates.length > 0 ? (
        <div className="space-y-3">
          {templates.map((template) => (
            <TemplateRow
              key={template.id}
              template={template}
              canEdit={canEdit}
            />
          ))}
        </div>
      ) : null}
      {/* Start as an "Add template" affordance; reveal the form on opt-in (see
          the "add" UX rule in CLAUDE.md). */}
      {canEdit && adding ? (
        <TemplateCreate onDone={() => setAdding(false)} />
      ) : null}
      {canEdit && !adding && templates.length > 0 ? (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          Add template
        </Button>
      ) : null}
      {templates.length > 0 ? (
        <LevelTemplateAssign
          levels={levels}
          templates={templates}
          canEdit={canEdit}
        />
      ) : null}
    </div>
  );
}

function onAuthError(router: ReturnType<typeof useRouter>) {
  router.push(`/sign-in?from=${encodeURIComponent(window.location.pathname)}`);
}

function TemplateRow({
  template,
  canEdit,
}: {
  template: DetailTemplate;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      toast.error("Template name is required.");
      return;
    }
    const body = String(data.get("body") ?? "");
    startTransition(async () => {
      try {
        await updateDetailTemplate(template.id, { name, body });
        toast.success("Template saved");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError(router);
        toast.error(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  function onDelete() {
    if (
      !window.confirm(
        `Delete the "${template.name}" template? Levels using it fall back to a blank body.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await deleteDetailTemplate(template.id);
        toast.success("Template deleted");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError(router);
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Name
          </span>
          <Input
            name="name"
            defaultValue={template.name}
            disabled={!canEdit}
            className="h-8"
          />
        </label>
        {canEdit ? (
          <div className="ml-auto flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
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
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Body</span>
        <MarkdownEditor
          name="body"
          defaultValue={template.body}
          disabled={!canEdit}
        />
      </div>
    </form>
  );
}

function TemplateCreate({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Choosing an example remounts the editor (via key) with its starter body.
  const [example, setExample] = useState("");
  const exampleBody =
    EXAMPLE_DETAIL_TEMPLATES.find((e) => e.key === example)?.body ?? "";

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      toast.error("Template name is required.");
      return;
    }
    const body = String(data.get("body") ?? "");
    const form = e.currentTarget;
    startTransition(async () => {
      try {
        await createDetailTemplate({ name, body });
        toast.success("Template added");
        form.reset();
        setExample("");
        onDone();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError(router);
        toast.error(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-md border border-dashed p-4"
    >
      <p className="text-sm font-medium">New template</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Name
          </span>
          <Input
            name="name"
            placeholder="e.g. Feature spec"
            className="h-8"
            autoFocus
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Start from
          </span>
          <Select
            value={example}
            onChange={(e) => setExample(e.target.value)}
            className="h-8 w-44"
          >
            <option value="">Blank</option>
            {EXAMPLE_DETAIL_TEMPLATES.map((e) => (
              <option key={e.key} value={e.key}>
                {e.name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Body</span>
        <MarkdownEditor key={example} name="body" defaultValue={exampleBody} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add template"}
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
    </form>
  );
}

function LevelTemplateAssign({
  levels,
  templates,
  canEdit,
}: {
  levels: WorkspaceLevel[];
  templates: DetailTemplate[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Only non-leaf levels are created in-app (leaf items come from specs), so
  // only they can seed a template.
  const assignable = levels.filter((l) => !l.isLeaf);
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      assignable.map((l) => [l.key, l.detailTemplateId ?? ""]),
    ),
  );

  function onSave() {
    const map: Record<string, string | null> = {};
    for (const l of assignable) map[l.key] = choice[l.key] || null;
    startTransition(async () => {
      try {
        await updateLevelTemplates(map);
        toast.success("Level templates saved");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError(router);
        toast.error(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-medium">Default per level</legend>
      <p className="text-xs text-muted-foreground">
        Pick which template seeds a new card&apos;s details at each level.
      </p>
      <div className="space-y-2">
        {assignable.map((level) => (
          <label
            key={level.key}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span>{level.label}</span>
            <Select
              aria-label={`Template for ${level.label}`}
              value={choice[level.key] ?? ""}
              disabled={!canEdit}
              onChange={(e) =>
                setChoice((prev) => ({ ...prev, [level.key]: e.target.value }))
              }
              className="h-8 w-56"
            >
              <option value="">None (blank)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </label>
        ))}
      </div>
      {canEdit ? (
        <Button type="button" size="sm" onClick={onSave} disabled={pending}>
          Save assignments
        </Button>
      ) : null}
    </fieldset>
  );
}
