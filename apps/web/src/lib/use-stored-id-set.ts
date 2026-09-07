"use client";

import { useCallback, useState } from "react";

import { useStoredValue } from "@/lib/use-stored-value";

/**
 * A remembered set of ids (which rows are collapsed, which trays are open),
 * persisted per scope key.
 *
 * Four views had this, and all four had the same three-part dance: seed state
 * with a default, restore from storage in a mount effect, and guard the
 * write-back effect with a `restored` flag so the restore did not immediately
 * overwrite storage with the default it was replacing. The flag existed only to
 * paper over the ordering problem the effect created.
 *
 * Reading storage as an external store removes the ordering problem rather than
 * guarding it: the stored set is the value from the first client render, so
 * there is no window in which the default could be written back over it.
 *
 * The fallback is captured once, matching `useState(initializer)`, which is what
 * these all used. A default computed from the current rows therefore stays the
 * default those rows produced when the view mounted, exactly as before.
 */
export function useStoredIdSet(
  storageKey: string,
  makeFallback: () => Set<string>,
): [Set<string>, (next: Set<string>) => void] {
  // `useState`'s lazy initializer, not a ref written during render: it captures
  // the fallback exactly once with no write to observe, which is both the
  // semantics these call sites had and a value React can see.
  const [fallback] = useState(makeFallback);

  // Stable across renders: `useStoredValue` caches by the raw string, and a
  // parse whose identity changed every render would defeat that.
  const parse = useCallback(
    (raw: string | null) => parseIdSet(raw, fallback),
    [fallback],
  );

  return useStoredValue(storageKey, parse, serializeIdSet, fallback);
}

/**
 * Read a stored id set, falling back on anything that is not one.
 *
 * Exported because this is where the interesting cases are and they are all
 * pure: a key holding someone else's data, a half-written value, a browser that
 * cleared storage between reads. Every one of those has to come back as "no
 * preference recorded" rather than as a crash inside a render.
 */
export function parseIdSet(
  raw: string | null,
  fallback: Set<string>,
): Set<string> {
  if (!raw) return fallback;
  try {
    const ids = JSON.parse(raw) as unknown;
    if (!Array.isArray(ids)) return fallback;
    return new Set(ids.filter((id): id is string => typeof id === "string"));
  } catch {
    return fallback;
  }
}

export const serializeIdSet = (ids: Set<string>) => JSON.stringify([...ids]);
