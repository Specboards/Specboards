import { DbStore } from "./db";
import { findRepoRoot, LocalFileStore } from "./local";
import type { FeatureStore } from "./types";

import { isLocalFileMode } from "@/lib/local-mode";
import { isMultiTenant } from "@/lib/tenancy";

export type * from "./types";
// Runtime values (types re-exported above via `export type *`).
export { BOARD_KEYS } from "./types";

let store: FeatureStore | undefined;

/**
 * Resolve the feature store once per process: Postgres when `DATABASE_URL`
 * is set, otherwise the zero-setup local file store — which now has to be
 * asked for with `SPECBOARDS_LOCAL_MODE`, because it is unauthenticated (see
 * `lib/local-mode.ts`). A missing connection string alone is a
 * misconfiguration and throws here rather than quietly serving the working
 * tree to anyone who asks.
 *
 * Tenant data uses `DATABASE_URL_APP`, the non-owner `specboards_app` role
 * that RLS enforces against. In multi-tenant (hosted) mode that connection is
 * REQUIRED: falling back to `DATABASE_URL` would silently connect as the
 * table owner, which bypasses RLS and reduces tenant isolation to hoping no
 * query ever misses a `workspaceId` filter. We fail closed instead; the
 * instrumentation boot probe reports the same misconfiguration at deploy
 * time. Single-tenant self-host keeps the one-connection fallback (there is
 * no other tenant to leak into). Onboarding/auth deliberately stay on the
 * owner connection (see lib/db.ts).
 */
export async function getStore(): Promise<FeatureStore> {
  if (!store) {
    if (process.env.DATABASE_URL) {
      const appUrl = process.env.DATABASE_URL_APP;
      if (!appUrl && isMultiTenant()) {
        // Not cached: every tenant-data request fails until the env is fixed.
        throw new Error(
          "DATABASE_URL_APP is required in multi-tenant mode: refusing to serve " +
            "tenant data over the owner connection, which bypasses row-level security.",
        );
      }
      store = new DbStore(appUrl ?? process.env.DATABASE_URL);
    } else {
      if (!isLocalFileMode()) {
        // Not cached: every request fails until the env is fixed. The boot
        // guard normally catches this first (see lib/local-mode.ts).
        throw new Error(
          "DATABASE_URL is not set and SPECBOARDS_LOCAL_MODE was not requested: " +
            "refusing to serve the unauthenticated local file store, which has " +
            "no sign-in and no membership check.",
        );
      }
      store = new LocalFileStore(await findRepoRoot());
    }
  }
  return store;
}
