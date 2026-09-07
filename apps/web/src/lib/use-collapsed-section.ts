"use client";

import { useCallback } from "react";

import { useStoredValue } from "@/lib/use-stored-value";

/**
 * A collapsible section whose open/closed choice is remembered per id.
 *
 * Two components had this, byte for byte apart from the storage key: the
 * settings groups and the item-detail sections. Both read a JSON map of id ->
 * collapsed, both seeded state with `defaultCollapsed` and corrected it in an
 * effect after mount, and both therefore rendered the wrong state once before
 * showing the right one.
 *
 * Values are explicit user choices, so a section with no entry falls back to
 * its `defaultCollapsed` rather than to "expanded". That distinction is why the
 * map holds booleans instead of a set of collapsed ids.
 */

type CollapsedMap = Record<string, boolean>;

/** Shared so the server snapshot is referentially stable across renders. */
const EMPTY: CollapsedMap = {};

function parseMap(raw: string | null): CollapsedMap {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Anything else in this key is someone else's data or a corrupted write;
    // either way the honest answer is "no preferences recorded".
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY;
    }
    return parsed as CollapsedMap;
  } catch {
    return EMPTY;
  }
}

const serializeMap = (map: CollapsedMap) => JSON.stringify(map);

export function useCollapsedSection(
  storageKey: string,
  id: string,
  defaultCollapsed: boolean,
): [boolean, (collapsed: boolean) => void] {
  const [map, setMap] = useStoredValue(
    storageKey,
    parseMap,
    serializeMap,
    EMPTY,
  );
  const collapsed = map[id] ?? defaultCollapsed;
  const setCollapsed = useCallback(
    (next: boolean) => setMap({ ...map, [id]: next }),
    [map, id, setMap],
  );
  return [collapsed, setCollapsed];
}
