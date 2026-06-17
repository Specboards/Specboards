import { DEFAULT_ESTIMATE_SCALE, type RepoConfig } from "./config.js";

/** The effective estimate scale + label for a feature's effort field. */
export interface EstimateConfig {
  label: string;
  scale: number[];
}

/**
 * The estimate config to drive the UI/validation: the repo's configured scale,
 * or the Fibonacci default when none is set.
 */
export function resolveEstimateConfig(
  config?: RepoConfig | null,
): EstimateConfig {
  return {
    label: config?.estimate?.label ?? "Estimate",
    scale: config?.estimate?.scale ?? [...DEFAULT_ESTIMATE_SCALE],
  };
}

/** A node in the parent/child tree carrying its own (un-rolled) estimate. */
export interface EstimateNode<K> {
  key: K;
  parentKey: K | null;
  estimate: number | null;
}

/**
 * Sum each node's estimate over its whole subtree (itself + all descendants),
 * keyed by `key`. A subtree with no estimates anywhere rolls up to `null`
 * rather than 0, so callers can distinguish "unestimated" from "zero points".
 * Tolerates malformed parent cycles (a node in a cycle contributes only its
 * own estimate).
 */
export function rollUpEstimates<K>(
  nodes: EstimateNode<K>[],
): Map<K, number | null> {
  const childrenOf = new Map<K, K[]>();
  const byKey = new Map<K, EstimateNode<K>>();
  for (const n of nodes) {
    byKey.set(n.key, n);
    if (n.parentKey != null) {
      const arr = childrenOf.get(n.parentKey) ?? [];
      arr.push(n.key);
      childrenOf.set(n.parentKey, arr);
    }
  }

  const result = new Map<K, number | null>();
  const visiting = new Set<K>();

  function compute(key: K): number | null {
    const cached = result.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return byKey.get(key)?.estimate ?? null; // cycle guard
    visiting.add(key);

    let sum = 0;
    let hasEstimate = false;
    const own = byKey.get(key)?.estimate ?? null;
    if (own != null) {
      sum += own;
      hasEstimate = true;
    }
    for (const child of childrenOf.get(key) ?? []) {
      const childTotal = compute(child);
      if (childTotal != null) {
        sum += childTotal;
        hasEstimate = true;
      }
    }

    visiting.delete(key);
    const total = hasEstimate ? sum : null;
    result.set(key, total);
    return total;
  }

  for (const n of nodes) compute(n.key);
  return result;
}
