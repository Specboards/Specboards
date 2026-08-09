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
import { saveButtonLabel, saveStatusLine } from "@/lib/spec-save-copy";
import {
  clearDraft,
  draftAge,
  hasMovedSince,
  isDraftWorthOffering,
  readDraft,
  writeDraft,
  type SpecDraft,
} from "@/lib/spec-draft";

/**
 * Headline for the conflict panel, naming what was actually fought over.
 * "You both changed Acceptance Criteria" is something a product manager can act
 * on; "a write conflict occurred" is something they forward to an engineer.
 */
function conflictHeading(sections: string[] | undefined): string {
  const named = (sections ?? []).map((s) => s || "the opening");
  if (named.length === 0) {
    return "Someone else changed this spec while you were writing";
  }
  const where =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return `You and someone else both changed ${where}`;
}

/**
 * Edit a spec-backed item's Markdown body. Saving commits the change to the
 * connected repo, since git is canonical for a spec and `spec_index` is a cache.
 *
 * Deliberately **not** the autosave that {@link FeatureDetailsEditor} gives a
 * DB-native card. A card's body is a database column and a save costs nothing;
 * a spec's is a commit, and debounced autosave would turn one editing session
 * into a dozen of them in the repo history. So the save here is an explicit act.
 *
 * What that act is *called* is not. The author this flow exists for did not opt
 * into git and cannot act on a sha or a branch name, so the copy says what
 * happened to their document: it is live, or it is waiting for review. The
 * mechanism stays reachable for anyone who wants it (the commit is in the status
 * line's tooltip, the review is a link) without being the primary reading. What
 * still has to be obvious is the *consequence*, because in review mode the board
 * keeps showing the old text and an author who was not told that reads it as a
 * lost edit.
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
  // A draft found on mount, held until the author decides. Never applied
  // silently: restoring on top of what is on screen without asking is the same
  // class of mistake as discarding it without asking.
  const [draft, setDraft] = useState<SpecDraft | null>(null);
  // Second-click guard on "Use theirs", which is destructive and sits beside
  // the button that is not.
  const [discarding, setDiscarding] = useState(false);
  // Other people's changes the last save absorbed, so the author can be told
  // their document moved under them even though nothing was lost.
  const [mergedWith, setMergedWith] = useState(0);
  // What this save is going to do. The server decides for real; this only sets
  // expectations, so an unknown mode falls back to the plainer commit wording.
  const proposes = writeMode === "pr";
  const copyState = {
    proposes,
    saving,
    dirty,
    proposed: Boolean(proposed),
    saved: commitSha !== null,
    path,
  };

  // The browser's own guard still runs: a draft is recovery, not a reason to
  // let someone close a tab on unsaved work without a word.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Offer back anything left over from a previous visit, once, on mount.
  useEffect(() => {
    const stored = readDraft(specId);
    if (isDraftWorthOffering(stored, initial)) setDraft(stored);
    // Keyed by the spec: a different item is a different draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specId]);

  function onChange(markdown: string) {
    draftRef.current = markdown;
    setDirty(markdown !== savedRef.current);
    if (error) setError(null);
    // Written on every change rather than debounced: this is a local write of a
    // string the browser already holds, and the moment worth protecting is the
    // one keystroke before someone closes the tab.
    if (markdown !== savedRef.current) {
      writeDraft(specId, {
        body: markdown,
        savedAt: new Date().toISOString(),
        baseSha: shaRef.current,
      });
    } else {
      clearDraft(specId);
    }
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
      // The text is in git now, so the local copy has nothing left to protect.
      clearDraft(specId);
      setDraft(null);
      setConflict(null);
      setCommitSha(result.commitSha);
      setProposed(result.pullRequest);
      setMergedWith(result.mergedWith ?? 0);
      // A merged save means the spec now holds an edit this author has not
      // read. Show them the merged document, not their own copy of it: leaving
      // their version on screen would mean the next save writes it back over
      // the paragraph that was just merged in, and pass every guard doing it.
      if (result.mergedWith && result.mergedBody !== undefined) {
        draftRef.current = result.mergedBody;
        savedRef.current = result.mergedBody;
        setBase(result.mergedBody);
        setEditorKey((k) => k + 1);
        toast.info(
          result.mergedWith === 1
            ? "Merged with one other change made while you were writing"
            : `Merged with ${result.mergedWith} other changes made while you were writing`,
        );
      }
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
      toast.success("Saved. Your change is live.");
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

  /** Put the draft back in the editor as the working copy. */
  function restoreDraft(stored: SpecDraft) {
    draftRef.current = stored.body;
    setBase(stored.body);
    setEditorKey((k) => k + 1);
    setDirty(stored.body !== savedRef.current);
    setDraft(null);
  }

  return (
    <div className="space-y-2">
      {draft ? (
        <div className="space-y-2 rounded-md border border-warning/50 bg-warning/5 p-3">
          <p className="text-sm font-medium">
            You have unsaved writing on this spec from {draftAge(draft.savedAt, new Date())}
          </p>
          <p className="text-xs text-muted-foreground">
            {/* Which version is which is the whole question here, so it is
                answered before either button. */}
            The editor is showing the version that is live. Your unsaved writing
            was never published; it stayed in this browser.
            {hasMovedSince(draft, shaRef.current)
              ? " The spec has also changed since you wrote it, so restoring will not include that change."
              : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => restoreDraft(draft)}>
              Restore my writing
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearDraft(specId);
                setDraft(null);
              }}
            >
              Discard it
            </Button>
          </div>
        </div>
      ) : null}
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
            {/* Naming the section is what makes this actionable. Reaching this
                panel at all means the edits genuinely overlap: anything that
                could be merged already was, server-side, without asking. */}
            <p className="text-sm font-medium">
              {conflictHeading(conflict.sections)}
            </p>
            {/* No shas, no branch names. The person this is for did not opt into
                git vocabulary and does not need it to make this decision. */}
            <p className="text-xs text-muted-foreground">
              Edits to other parts of the spec are merged in automatically, so
              this is a part you both rewrote. Your version is still in the
              editor above and has not been saved. Below is what {path} says now.
              Copy anything you need from it, then keep yours, or start again
              from theirs.
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
          {saveButtonLabel(copyState)}
        </Button>
        <p
          className="text-2xs text-muted-foreground"
          role="status"
          aria-live="polite"
          // The commit is still reachable for anyone who wants it, without
          // being the primary reading. Someone debugging can hover; the author
          // this flow is for never has to learn what a sha is.
          title={commitSha ? `Commit ${commitSha.slice(0, 7)}` : undefined}
        >
          {saveStatusLine(copyState)}
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
      {/* Stays on screen after the toast goes. Someone who saved, looked away,
          and looked back should still find out their spec picked up an edit
          they have not read. */}
      {mergedWith > 0 && !dirty ? (
        <p className="text-2xs text-muted-foreground">
          {mergedWith === 1
            ? "Merged with one other change made while you were writing. The editor now shows the combined version."
            : `Merged with ${mergedWith} other changes made while you were writing. The editor now shows the combined version.`}
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
