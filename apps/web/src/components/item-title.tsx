"use client";

import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";

import { AuthRequiredError, patchFeature } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * The item title, shown as a heading. For DB-native items the user can edit it
 * (its title lives in the DB): the heading is a borderless, auto-growing
 * textarea that saves on blur or Enter. Spec-backed titles come from git and
 * render as static text. Native undo (Cmd/Ctrl+Z) works while focused.
 */
export function ItemTitle({
  specId,
  title,
  canEdit,
  className,
}: {
  specId: string;
  title: string;
  canEdit: boolean;
  className?: string;
}) {
  const router = useRouter();
  const savedRef = useRef(title);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);

  // Grow the textarea to fit its content (single line up to full wrap).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);

  const base = cn("font-semibold tracking-tight leading-tight", className);

  if (!canEdit) {
    return <h1 className={base}>{title}</h1>;
  }

  async function commit() {
    const next = value.trim();
    if (next === "" ) {
      // Don't allow an empty title; revert to the last saved value.
      setValue(savedRef.current);
      return;
    }
    if (next === savedRef.current) return;
    setError(null);
    try {
      await patchFeature(specId, { title: next });
      savedRef.current = next;
      setValue(next);
      router.refresh();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        router.push(
          `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
        );
        return;
      }
      setError(err instanceof Error ? err.message : "Rename failed.");
    }
  }

  return (
    <div>
      <textarea
        ref={taRef}
        aria-label="Title"
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={cn(
          base,
          "-mx-1 block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-1 py-0.5 outline-none",
          "hover:bg-muted/50 focus:bg-muted/50",
        )}
      />
      {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
