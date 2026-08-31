/**
 * Items: the read side, in local file mode.
 *
 * Three methods, and all three start from `loadAll`, which is the whole of the
 * difference from the Postgres store. There is no query language here: the only
 * way to answer "which items match this" is to assemble every item from the
 * specs directory and the two state files and then filter in memory. That is
 * fine for a repository someone is working in and would not be fine for a
 * workspace, which is why the two stores exist.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import {
  type FeatureDetail,
  type FeatureRecord,
  type WorkspaceScope,
} from "../types";

import { type LocalStoreContext } from "./context";

// The local store has a single implicit workspace, so `scope` is ignored.
export async function listFeatures(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<FeatureRecord[]> {
  return ctx.loadAll();
}

export async function listFeatureBodies(
  ctx: LocalStoreContext,
  specIds: readonly string[],
  _scope?: WorkspaceScope,
): Promise<Map<string, string>> {
  if (specIds.length === 0) return new Map();
  const wanted = new Set(specIds);
  const all = await ctx.loadAll();
  const out = new Map<string, string>();
  for (const f of all) {
    if (wanted.has(f.specId) && f.content) out.set(f.specId, f.content);
  }
  return out;
}

export async function getFeature(
  ctx: LocalStoreContext,
  specId: string,
  _scope?: WorkspaceScope,
): Promise<FeatureDetail | null> {
  const all = await ctx.loadAll();
  return all.find((f) => f.specId === specId) ?? null;
}
