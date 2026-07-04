"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { MarkdownEditor } from "@/components/markdown-editor";
import { AuthRequiredError, patchFeature } from "@/lib/api-client";

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
}: {
  specId: string;
  /** Current Markdown body (seed value; the editor owns state after mount). */
  initial: string;
  placeholder?: string;
  /** Min-height utility for the editor surface (e.g. "min-h-[15rem]"). */
  minHeightClass?: string;
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
      router.refresh();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        router.push(
          `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
        );
        return;
      }
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
          className="h-4 text-[11px] text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </p>
      )}
    </div>
  );
}
