"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { AuthRequiredError, updateSpecBody } from "@/lib/api-client";

/**
 * Edit a spec-backed item's Markdown body. Saving commits the change to the
 * connected repo, since git is canonical for a spec and `spec_index` is a cache.
 *
 * Deliberately **not** the autosave that {@link FeatureDetailsEditor} gives a
 * DB-native card. A card's body is a database column and a save costs nothing;
 * a spec's is a commit, and debounced autosave would turn one editing session
 * into a dozen of them in the repo history. So the save here is an explicit act,
 * announced as a commit and reporting the sha it produced. The two paths are
 * also kept visibly distinct on purpose: from v0.26.2 this one can open a pull
 * request, and an author who was never told their edit goes through git will not
 * understand what happened to it.
 *
 * The editor only ever sees the body. Frontmatter (and with it the stable `id`
 * that ties the file to its board row through renames) is reattached server-side
 * by `rewriteSpecBody`, so it is never round-tripped through the editor.
 */
export function SpecBodyEditor({
  specId,
  path,
  initial,
  minHeightClass,
  onSaved,
}: {
  specId: string;
  /** Repo-relative path of the spec file, shown so the target is never a guess. */
  path: string;
  /** Current Markdown body, frontmatter already stripped. */
  initial: string;
  /** Min-height utility for the editor surface (e.g. "min-h-[15rem]"). */
  minHeightClass?: string;
  /** Called after a successful commit, for views that hold the item in local
   * state and must re-read it (the flyout) rather than relying on a refresh. */
  onSaved?: () => void;
}) {
  const router = useRouter();
  // The editor owns its content; we track the latest Markdown so the Save
  // button can commit it without remounting or controlling the editor.
  const draftRef = useRef(initial);
  const savedRef = useRef(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitSha, setCommitSha] = useState<string | null>(null);

  // With an explicit save, a closed tab loses the edit. Drafts are a later
  // feature; until then the browser's own guard is what stands between an
  // author and silently losing their work.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function onChange(markdown: string) {
    draftRef.current = markdown;
    setDirty(markdown !== savedRef.current);
    if (error) setError(null);
  }

  async function save() {
    const value = draftRef.current;
    if (value === savedRef.current || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateSpecBody(specId, value);
      savedRef.current = value;
      setDirty(false);
      setCommitSha(result.commitSha);
      toast.success(`Committed ${result.commitSha.slice(0, 7)}`);
      // updateSpecContent re-syncs the repo before returning, so the cache is
      // already current: re-render from it, so what the author reads back is
      // what landed in git rather than their own optimistic copy.
      router.refresh();
      onSaved?.();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        router.push(
          `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
        );
        return;
      }
      // The server's messages are written for a human, so show them as they are.
      setError(err instanceof Error ? err.message : "Saving the spec failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <MarkdownEditor
        name="specBody"
        defaultValue={initial}
        placeholder="Write the spec…"
        onChange={onChange}
        minHeightClass={minHeightClass}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          {saving ? "Committing…" : "Commit changes"}
        </Button>
        <p className="text-2xs text-muted-foreground" role="status" aria-live="polite">
          {saving
            ? `Committing to ${path}…`
            : dirty
              ? `Unsaved changes. Committing writes ${path} to the repo.`
              : commitSha
                ? `Committed ${commitSha.slice(0, 7)} to ${path}.`
                : `Saved changes are committed to ${path}.`}
        </p>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
