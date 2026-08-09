"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileText, Plus } from "lucide-react";
import { toast } from "sonner";

import { specFilePath, type DetailTemplate } from "@specboards/core";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { AuthRequiredError, createSpec } from "@/lib/api-client";
import type { LinkableRepo } from "@/lib/github-links-service";

/**
 * What the new spec is being created *for*. The two cases produce very
 * different outcomes on the board, so they are distinct rather than one call
 * with an optional field:
 *
 * - `attach` writes the existing item's own id into the new file's
 *   frontmatter, so the sync links the file to the row already on the board.
 *   The item keeps its id, status, assignee, parent, comments and history: it
 *   gains a document, it does not become a second card.
 * - `child` creates a brand-new spec and item, nested under the given card.
 */
export type SpecCreateTarget =
  | { kind: "attach"; workItemId: string; itemTitle: string }
  | { kind: "child"; parentSpecId: string; parentTitle: string };

/**
 * "Attach a spec" / "New spec": create a `specs/<slug>/spec.md`, commit it to a
 * connected repo, and bring it onto the board.
 *
 * Collapsed to a single control until the author opts in, then the fields
 * expand in place and collapse again on success, so a card that nobody is
 * documenting right now carries no open form.
 *
 * Two details worth knowing:
 *
 * - Attaching carries the card's existing description into the spec, but the
 *   **server** does that seeding, not this form. Once a spec is attached the
 *   board reads the item's body from the file rather than from the `details`
 *   column, so a description left behind stops being rendered. Sending the copy
 *   this component was rendered with would miss the case that matters most: an
 *   author who types a description and attaches a spec in the same breath, whose
 *   text this component has not seen yet.
 * - The path preview is computed from the same slug rule the server uses
 *   (`specFilePath` in core, shared for exactly this reason), so the file named
 *   before the commit is the file that gets written.
 */
export function CreateSpecButton({
  target,
  repos,
  templates = [],
  onCreated,
}: {
  target: SpecCreateTarget;
  /** Connected repos, spec repo first; `repos[0]` is the default target. */
  repos: LinkableRepo[];
  /**
   * Starting points offered for a brand-new spec. Not offered when attaching:
   * there the card's own description becomes the body, so a template would be
   * a control that quietly does nothing.
   */
  templates?: DetailTemplate[];
  /** Called after a successful create, for views holding state locally. */
  onCreated?: () => void;
}) {
  const router = useRouter();
  const attaching = target.kind === "attach";
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(attaching ? target.itemTitle : "");
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  // "" means "whatever the workspace has set for this level", which the server
  // resolves; it is not the same as picking a template called nothing.
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const path = specFilePath(title);
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];
  const showTemplates = !attaching && templates.length > 0;

  function expand() {
    setTitle(attaching ? target.itemTitle : "");
    setRepoId(repos[0]?.id ?? "");
    setTemplateId("");
    setError(null);
    setOpen(true);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    if (!path) {
      setError("Give the spec a title with at least one letter or number.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await createSpec({
        title,
        repoId: repoId || undefined,
        // No `body` on attach: the server seeds it from the item's current
        // description, which this component may not have seen yet.
        ...(target.kind === "attach"
          ? { workItemId: target.workItemId }
          : {
              parentSpecId: target.parentSpecId,
              templateId: templateId || undefined,
            }),
      });
      toast.success(
        attaching
          ? `Spec attached at ${result.spec.path}`
          : `Spec created at ${result.spec.path}`,
      );
      // The create failed only partly: the file is in the repo either way, so
      // this is a warning to read, not a reason to try again.
      if (result.parentWarning) toast.warning(result.parentWarning);
      setOpen(false);
      // createSpec re-syncs the repo before returning, so the board is already
      // current; re-render from it rather than from an optimistic guess.
      router.refresh();
      onCreated?.();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        router.push(
          `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
        );
        return;
      }
      // The server's messages are written for a human, including the slug
      // collision ("… already exists … Pick a different title."), which is the
      // rename prompt: it lands next to the title field the author must change.
      setError(err instanceof Error ? err.message : "Creating the spec failed.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-xs"
        onClick={expand}
      >
        {attaching ? (
          <FileText className="size-3.5" />
        ) : (
          <Plus className="size-3.5" />
        )}
        {attaching ? "Attach a spec" : "New spec"}
      </Button>
    );
  }

  return (
    <form
      onSubmit={submit}
      // Full width so the expanded form drops onto its own line when it sits in
      // a wrapping row of controls rather than being squeezed beside them.
      className="w-full space-y-3 rounded-md border bg-muted/30 p-3"
    >
      <p className="text-xs text-muted-foreground">
        {attaching
          ? "Gives this item a spec document. The item keeps its status, assignee, parent and history, and its description becomes the spec's body."
          : `Creates a spec and nests it under “${target.parentTitle}”.`}
      </p>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Title</span>
        <Input
          value={title}
          autoFocus
          className="h-8"
          onChange={(e) => {
            setTitle(e.target.value);
            if (error) setError(null);
          }}
        />
      </label>
      {showTemplates ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Start from
          </span>
          <Select
            value={templateId}
            className="h-8"
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {/* The workspace's own default for this level, resolved server-side.
                Named vaguely on purpose: this component does not know which
                template the level points at, and guessing would be worse than
                not saying. */}
            <option value="">Workspace default</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      {repos.length > 1 ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Repository
          </span>
          <Select
            value={repoId}
            className="h-8"
            onChange={(e) => setRepoId(e.target.value)}
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
                {r.isSpecRepo ? " (specs)" : ""}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      <p className="text-2xs text-muted-foreground" role="status" aria-live="polite">
        {path && repo ? (
          <>
            Commits <span className="font-mono">{path}</span> to{" "}
            <span className="font-mono">
              {repo.owner}/{repo.name}
            </span>
            .
          </>
        ) : (
          "Give the spec a title with at least one letter or number."
        )}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving || !path}>
          {saving
            ? attaching
              ? "Attaching…"
              : "Creating…"
            : attaching
              ? "Attach spec"
              : "Create spec"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
