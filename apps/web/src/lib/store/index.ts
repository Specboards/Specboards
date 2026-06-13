import { DbStore } from "./db";
import { findRepoRoot, LocalFileStore } from "./local";
import type { FeatureStore } from "./types";

export type * from "./types";

let store: FeatureStore | undefined;

/**
 * Resolve the feature store once per process: Postgres when `DATABASE_URL`
 * is set, otherwise the zero-setup local file store.
 *
 * Tenant data uses `DATABASE_URL_APP` — the non-owner `specboard_app` role
 * that RLS enforces against — when it is set, falling back to `DATABASE_URL`
 * (owner) so single-connection self-host and pre-cutover deploys still work.
 * Onboarding/auth deliberately stay on the owner connection (see lib/db.ts).
 */
export async function getStore(): Promise<FeatureStore> {
  if (!store) {
    store = process.env.DATABASE_URL
      ? new DbStore(process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL)
      : new LocalFileStore(await findRepoRoot());
  }
  return store;
}
