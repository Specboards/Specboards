"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { MarkdownEditor } from "@/components/markdown-editor";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { patchFeature } from "@/lib/api-client/work-items";

/**
 * Edit a DB-native item's Details body (Markdown). Saves are automatic: edits
 * debounce and commit on their own, with no manual Save button. The editor is
 * never remounted on save, so the caret and content stay put — undo/redo use
 * the editor's native history (Cmd/Ctrl+Z). Spec-backed items don't use this:
 * their body lives in git and is rendered read-only.
 *
 * The prior version remounted the editor after each save to reseed from the
 * server value, which raced `router.refresh()` and briefly wiped the freshly
 * typed body until a full reload. Holding the mount fixes that.
 */
export function FeatureDetailsEditor({
  specId,
  initial,
  placeholder = "Add a description…",
  minHeightClass,
  onDirtyChange,
  onSaved,
}: {
  specId: string;
  /** Current Markdown body (seed value; the editor owns state after mount). */
  initial: string;
  placeholder?: string;
  /** Min-height utility for the editor surface (e.g. "min-h-[15rem]"). */
  minHeightClass?: string;
  /**
   * Whether there is typing that has not reached the server yet: a debounce
   * still counting down, or a save in flight or failed. The Description block
   * refuses to collapse over it, because collapsing unmounts this editor.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * The body as it was last persisted. The parent needs it because this editor
   * never remounts on its own saves, so `initial` goes stale the moment anyone
   * types; anything that re-renders from the body (a folded preview, a remount
   * after unfolding) would otherwise show the version the page loaded with.
   */
  onSaved?: (body: string) => void;
}) {
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  // The last value we successfully persisted, to skip no-op saves (e.g. the
  // editor's initial normalization pass emitting the seed value back).
  const savedRef = useRef(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  async function save(value: string) {
    if (value === savedRef.current) return;
    if (inFlightRef.current) {
      // A save is in flight; remember the latest value and run once it settles.
      pendingRef.current = value;
      return;
    }
    inFlightRef.current = true;
    setStatus("saving");
    setError(null);
    try {
      await patchFeature(specId, { details: value.trim() ? value : null });
      savedRef.current = value;
      setStatus("saved");
      onSaved?.(value);
      // Still dirty if more typing arrived while this was in flight; the
      // follow-up save in `finally` clears it.
      if (pendingRef.current === null) onDirtyChange?.(false);
      router.refresh();
    } catch (err) {
      if (redirectOnAuthExpiry(err, router)) return;
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current !== null) {
        const next = pendingRef.current;
        pendingRef.current = null;
        void save(next);
      }
    }
  }

  function onChange(markdown: string) {
    // Dirty from the keystroke, not from the save attempt: the window this
    // guards is exactly the one where the text exists only in the editor.
    // Reported both ways, because typing back to the saved text produces a
    // no-op save that would otherwise leave the block permanently unfoldable.
    onDirtyChange?.(markdown !== savedRef.current);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void save(markdown), 700);
  }

  return (
    <div className="space-y-1.5">
      <MarkdownEditor
        name="details"
        defaultValue={initial}
        placeholder={placeholder}
        onChange={onChange}
        minHeightClass={minHeightClass}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p
          className="h-4 text-2xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </p>
      )}
    </div>
  );
}
