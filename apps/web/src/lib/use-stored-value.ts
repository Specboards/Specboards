"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A `localStorage` value read as an external store, so a component can use it
 * without a render-then-correct-in-an-effect round trip.
 *
 * Every persisted preference in the app had the same shape: seed state with the
 * server's default, then `useEffect(() => setX(readStorage()), [])` to correct
 * it after hydration. That renders twice by construction and is what
 * `react-hooks/set-state-in-effect` objects to.
 *
 * `useSyncExternalStore` is the hook for this exact problem. `getServerSnapshot`
 * returns the fallback, which is what the server rendered and what hydration
 * must match; `getSnapshot` reads storage, which is right from the first client
 * render onwards. One render, no effect, and the value stays correct.
 *
 * Snapshots must be referentially stable or React re-renders forever, so the
 * parsed value is memoized per raw string. Callers therefore get a value that
 * only changes identity when the stored text does.
 *
 * Writes go through `set`, which notifies this tab (the `storage` event does
 * not fire in the tab that wrote) and, through that same event, any other tab
 * showing the app.
 */

/** Subscribers in this tab, by storage key. */
const listeners = new Map<string, Set<() => void>>();

/** Last raw string seen per key, and the value parsed from it. */
const parsed = new Map<string, { raw: string | null; value: unknown }>();

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

if (typeof window !== "undefined") {
  // Another tab wrote. `event.key` is null when storage was cleared wholesale,
  // in which case every key we track has potentially changed.
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      parsed.clear();
      for (const key of listeners.keys()) notify(key);
      return;
    }
    parsed.delete(event.key);
    notify(event.key);
  });
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode, or storage disabled. The fallback is the right answer and
    // a preference is never worth throwing a render for.
    return null;
  }
}

/**
 * Read `key` from localStorage as React state, plus a setter that persists.
 *
 * `parse` turns the stored string into the value, and is given `null` when
 * nothing is stored. `serialize` turns it back. Both must be pure and stable;
 * pass module-level functions, not inline closures.
 */
export function useStoredValue<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string,
  /** What the server rendered. Hydration must agree with this. */
  serverValue: T,
): [T, (value: T) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(key);
      };
    },
    [key],
  );

  const getSnapshot = useCallback((): T => {
    const raw = readRaw(key);
    const cached = parsed.get(key);
    // Re-parsing on every snapshot would hand React a new object each time and
    // spin. Only the raw string decides whether the value can have changed.
    if (cached && cached.raw === raw) return cached.value as T;
    const value = parse(raw);
    parsed.set(key, { raw, value });
    return value;
  }, [key, parse]);

  const getServerSnapshot = useCallback(() => serverValue, [serverValue]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const set = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, serialize(next));
      } catch {
        // Unwritable storage still updates this tab for the session; the
        // preference simply will not survive a reload.
      }
      parsed.set(key, { raw: readRaw(key), value: next });
      notify(key);
    },
    [key, serialize],
  );

  return [value, set];
}
