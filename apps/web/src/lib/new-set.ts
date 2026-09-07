/**
 * An empty set, as a stable factory.
 *
 * `useStoredIdSet` takes a factory so a default computed from props is captured
 * once, the way `useState(initializer)` captures it. Most callers just want
 * "nothing collapsed", and passing `() => new Set()` inline at each site would
 * be four identical closures that read like they might differ.
 */
export function newSet(): Set<string> {
  return new Set();
}
