"use client";

import { useState } from "react";

/**
 * Run `reset` when `key` changes, during render rather than in an effect.
 *
 * This is React's own documented answer to "adjust state when a prop changes",
 * and it replaces the shape that was written a dozen times in this codebase:
 *
 * ```tsx
 * useEffect(() => setValue(props.value), [props.value]);
 * ```
 *
 * That works, and it is what `react-hooks/set-state-in-effect` objects to. The
 * effect version renders the component once with the stale value, commits it to
 * the DOM, then runs the effect, sets state and renders again. The reader can
 * see the intermediate frame, and every one of these was a "re-sync when the
 * parent hands us a different item" comment describing a flash nobody wanted.
 *
 * Setting state during render is not a mistake here: React explicitly supports
 * it for this case. It discards the in-progress render and restarts before
 * touching the DOM, so there is no intermediate commit and no extra frame. The
 * cost is that `reset` must only set state on this component, and must be safe
 * to run twice.
 *
 * `key` is compared with `Object.is`, so pass a primitive (an id, a status, a
 * count) rather than an object that is rebuilt on every render. A tuple that
 * changes identity every render would reset the state every render, which is
 * the one way to get this badly wrong.
 */
export function useResetOnChange<K>(key: K, reset: () => void): void {
  const [previous, setPrevious] = useState(key);
  if (!Object.is(previous, key)) {
    setPrevious(key);
    reset();
  }
}
