"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import {
  AuthRequiredError,
  SpecConflictError,
  updateSpecBody,
  type SpecConflict,
  type SpecWriteResult,
} from "@/lib/api-client";

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
  blobSha,
  writeMode,
  minHeightClass,
  onSaved,
}: {
  specId: string;
  /** Repo-relative path of the spec file, shown so the target is never a guess. */
  path: string;
  /** Current Markdown body, frontmatter already stripped. */
  initial: string;
  /**
   * Blob sha `initial` came from. Sent with the save so a change made in git
   * since this page rendered is refused rather than overwritten. Null (local
   * file mode, or an item with no index row) means the save is unguarded, which
   * is the behaviour that existed before the guard.
   */
  blobSha?: string | null;
  /**
   * How this repo takes spec changes. `pr` means saving asks for review rather
   * than publishing, which the author needs to know *before* they save: the
   * board will keep showing the old text afterwards, and that reads as a lost
   * edit to anyone who was not told.
   */
  writeMode?: "pr" | "direct" | null;
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
  const [proposed, setProposed] = useState<SpecWriteResult["pullRequest"]>();
  // The version that beat a guarded save, held until the author decides what to
  // do about it. Their draft stays in the editor the whole time: this is the
  // moment where losing someone's writing costs the most trust.
  const [conflict, setConflict] = useState<SpecConflict | null>(null);
  // Sha the next save is guarded by. Starts as the one the page loaded and
  // moves forward on every write, so a second save in the same session is
  // guarded against the first rather than against a sha that is now stale.
  const shaRef = useRef<string | null>(blobSha ?? null);
  // The editor is uncontrolled once mounted, so adopting the incoming version
  // means remounting it with a new starting point rather than setting a value.
  const [base, setBase] = useState(initial);
  const [editorKey, setEditorKey] = useState(0);
  // Second-click guard on "Use theirs", which is destructive and sits beside
  // the button that is not.
  const [discarding, setDiscarding] = useState(false);
  // What this save is going to do. The server decides for real; this only sets
  // expectations, so an unknown mode falls back to the plainer commit wording.
  const proposes = writeMode === "pr";

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

  /**
   * Save the current draft. `guardWith` overrides the sha the write is checked
   * against, which is how "keep mine" gets through: it is not an unguarded
   * write, it is a guarded write against the version the author has now been
   * shown and chosen to replace.
   */
  async function save(guardWith?: string) {
    const value = draftRef.current;
    if (saving) return;
    if (value === savedRef.current && !guardWith) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateSpecBody(specId, value, {
        expectedBlobSha: guardWith ?? shaRef.current,
      });
      savedRef.current = value;
      shaRef.current = result.blobSha;
      setDirty(false);
      setConflict(null);
      setCommitSha(result.commitSha);
      setProposed(result.pullRequest);
      if (result.pullRequest) {
        toast.success(
          result.pullRequest.created
            ? `Sent for review as #${result.pullRequest.number}`
            : `Added to review #${result.pullRequest.number}`,
        );
        // Deliberately no refresh. The change is on a working branch, so the
        // server would answer with the *previous* text and the author would
        // watch their writing revert in front of them. What is on screen is
        // what they proposed; leave it there.
        return;
      }
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
      // A conflict opens the resolution panel instead of an error line. The
      // draft is untouched and still dirty, which is the point: an author whose
      // ten minutes of writing is thrown away by a toast stops trusting the
      // editor and goes back to asking an engineer.
      if (err instanceof SpecConflictError) {
        setConflict(err.conflict);
        return;
      }
      // The server's messages are written for a human, so show them as they are.
      setError(err instanceof Error ? err.message : "Saving the spec failed.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Take the incoming version as the new starting point, replacing the draft.
   * Remounting the editor is what makes the swap visible, since it owns its
   * content once mounted.
   *
   * Reached only through a second click (see `discarding`). This is the one
   * action on this panel that throws the author's writing away, and it sits
   * next to the one that keeps it, so a stray click must not be enough.
   */
  function adoptTheirs(incoming: SpecConflict) {
    draftRef.current = incoming.currentContent;
    savedRef.current = incoming.currentContent;
    shaRef.current = incoming.currentBlobSha;
    setBase(incoming.currentContent);
    setEditorKey((k) => k + 1);
    setDirty(false);
    setDiscarding(false);
    setConflict(null);
  }

  return (
    <div className="space-y-2">
      <MarkdownEditor
        key={editorKey}
        name="specBody"
        defaultValue={base}
        placeholder="Write the spec…"
        onChange={onChange}
        minHeightClass={minHeightClass}
      />
      {conflict ? (
        <div className="space-y-3 rounded-md border border-warning/50 bg-warning/5 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Someone else changed this spec while you were writing
            </p>
            {/* No shas, no branch names. The person this is for did not opt into
                git vocabulary and does not need it to make this decision. */}
            <p className="text-xs text-muted-foreground">
              Your version is still in the editor above and has not been saved.
              Below is what {path} says now. Copy anything you need from it,
              then keep yours, or start again from theirs.
            </p>
          </div>
          <div className="max-h-64 overflow-auto rounded border bg-background p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-2xs">
              {conflict.currentContent || "(the spec is now empty)"}
            </pre>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => save(conflict.currentBlobSha)}
              disabled={saving}
            >
              {saving ? "Saving…" : "Keep mine"}
            </Button>
            {discarding ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => adoptTheirs(conflict)}
                  disabled={saving}
                >
                  Discard my version
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDiscarding(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDiscarding(true)}
                disabled={saving}
              >
                Use theirs
              </Button>
            )}
            <p className="text-2xs text-muted-foreground">
              {discarding
                ? "This replaces what you wrote above."
                : "Keeping yours replaces the version below."}
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => save()} disabled={!dirty || saving}>
          {saving
            ? proposes
              ? "Sending…"
              : "Committing…"
            : proposes
              ? "Send for review"
              : "Commit changes"}
        </Button>
        <p className="text-2xs text-muted-foreground" role="status" aria-live="polite">
          {saving
            ? proposes
              ? `Proposing a change to ${path}…`
              : `Committing to ${path}…`
            : dirty
              ? proposes
                ? `Unsaved changes. Sending asks for a review of ${path}.`
                : `Unsaved changes. Committing writes ${path} to the repo.`
              : proposed
                ? `Waiting for review. ${path} keeps its current text on the board until this is approved.`
                : commitSha
                  ? `Committed ${commitSha.slice(0, 7)} to ${path}.`
                  : proposes
                    ? `Changes to ${path} go for review before they reach the board.`
                    : `Saved changes are committed to ${path}.`}
        </p>
        {/* The link is the whole point of saying a change is under review: an
            author who cannot reach the review has been told to wait with no way
            to find out what for. */}
        {proposed ? (
          <a
            className="text-2xs font-medium underline underline-offset-2"
            href={proposed.url}
            target="_blank"
            rel="noreferrer"
          >
            {proposed.created
              ? `Review #${proposed.number}`
              : `Added to review #${proposed.number}`}
          </a>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
