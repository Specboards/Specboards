/**
 * The vocabulary every domain module of the Postgres store shares.
 *
 * Step 3 of the FeatureStore split moves `db/index.ts` out one domain at a
 * time. A domain module is plain functions rather than methods, so whatever it
 * used to reach for through `this` has to be named explicitly: that is
 * `DbStoreContext`. `DbStore` implements it and passes itself, so the calls
 * resolve to the same code they always did.
 *
 * Nothing here escapes `lib/store/db/`. `store/index.ts` hands callers a
 * `FeatureStore` and this is below that line.
 */

import {
  DEFAULT_STATUSES,
  canReadProduct,
  canWriteProduct,
  safeParseRepoConfig,
  terminalStatus,
  type WorkspaceLevel,
} from "@specboards/core";

import {
  asc,
  eq,
  repositories,
  workspaceStatuses,
  type Database,
} from "@specboards/db";

import type {
  CustomFieldValue,
  GithubLinkAggregate,
  OutboxEmit,
  ProductAccess,
  WorkspaceScope,
} from "../types";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ProductVisibilityRow = { id: string; visibility: "org" | "private" };

/**
 * What a domain module may ask of the store it belongs to.
 *
 * Deliberately small. These are the members more than one domain needs: the
 * scoped transaction runner, and the two workspace lookups (who is acting, and
 * is this product real) that every product-scoped authorization check starts
 * from. It grows as further domains move out, and each addition should be a
 * member genuinely shared rather than one domain's helper made public.
 */
export interface DbStoreContext {
  /**
   * Run `fn` in a transaction with the RLS session variable set for `scope`.
   * See the implementation on `DbStore` for why an absent scope throws rather
   * than defaulting.
   */
  scoped<T>(
    scope: WorkspaceScope | undefined,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T>;
  /** Build the acting user's product access (org-admin flag + per-product roles). */
  accessIn(tx: Tx, scope: WorkspaceScope): Promise<ProductAccess>;
  /** Verify a product id belongs to the workspace, returning it. */
  requireProductId(tx: Tx, ws: string, productId: string): Promise<string>;
  /**
   * The workspace's default product id, creating it if it is somehow missing.
   * Every domain that accepts an optional product id lands here when none was
   * given, which is why it is context rather than one domain's helper.
   */
  defaultProductId(tx: Tx, ws: string): Promise<string>;
  /**
   * The workspace hierarchy as it applies to `productId` (or the workspace
   * default when null), with per-product overrides already resolved.
   */
  levelsIn(
    tx: Tx,
    workspaceId: string,
    productId?: string | null,
  ): Promise<WorkspaceLevel[]>;
  /**
   * Every product in the workspace with its visibility, keyed by id. The other
   * half of a read check: `accessIn` says what the caller may reach and this
   * says what there is to reach, and `canReadProductId` needs both.
   */
  productVisibilityIn(
    tx: Tx,
    workspaceId: string,
  ): Promise<Map<string, ProductVisibilityRow>>;
  /**
   * Append a transactional-outbox row inside the caller's own transaction, so
   * the event commits atomically with the change that produced it. Shared by
   * every domain that emits: items, releases and goals.
   */
  writeOutbox(tx: Tx, scope: WorkspaceScope, emit: OutboxEmit): Promise<void>;
}

export /**
 * Read a level-keyed override map off a jsonb column. Anything that is not a
 * plain object (null, an array, a hand-edited scalar) reads as "no overrides",
 * so a malformed row degrades to inheriting rather than throwing on every page
 * that renders a card.
 */
function asLevelMap<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, T>;
}

/** A GitHub link roll-up with nothing in it yet. */
export function emptyAgg(): GithubLinkAggregate {
  return { openPrs: 0, mergedPrs: 0, issues: 0, branches: 0, total: 0 };
}

/** Normalize the jsonb custom-fields column into the UI's value map. */
export function toCustomFields(
  value: unknown,
): Record<string, CustomFieldValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, CustomFieldValue>)
    : {};
}

export function canReadProductId(
  access: ProductAccess,
  productById: ReadonlyMap<string, ProductVisibilityRow>,
  productId: string | null,
): boolean {
  if (productId === null) return true;
  const product = productById.get(productId);
  return product ? canReadProduct(access, product) : false;
}

export function canWriteProductId(
  access: ProductAccess,
  productId: string | null,
): boolean {
  if (productId === null) return access.isOrgAdmin;
  return canWriteProduct(access, productId);
}

/**
 * Which status means "finished", per product, for one workspace.
 *
 * Every progress figure in the product (hierarchy roll-up, cycle burndown, goal
 * delivery, release totals) asks the same question of a status key, and it used
 * to be answered with `status === "done"`. That is only right for the built-in
 * vocabulary. A workspace whose stages end in `shipped` reported every one of
 * those figures as zero, which reads as "nothing is progressing" rather than
 * "this metric does not apply here", and it silently emptied the roadmap bars
 * too.
 *
 * Resolution mirrors `resolveWorkflowFor`: a product's own stage set if it has
 * defined one, else the workspace default set, else the repo config's
 * vocabulary, else the built-in one. The terminal stage of whichever set wins is
 * the done status (see {@link terminalStatus}).
 */
export interface DoneStatuses {
  /**
   * Whether an item at `status` in `productId` is finished. Pass the item's own
   * product: a cross-product aggregate can hold work from products whose stage
   * sets disagree, and each row has to be judged by its own.
   */
  isDone(status: string, productId?: string | null): boolean;
  /** The done status for `productId`, for callers that need the key itself. */
  keyFor(productId?: string | null): string;
  /**
   * Every done status in the workspace, for the SQL-side filters that cannot
   * ask per row. Products may disagree, so a query spanning them has to exclude
   * all of their terminal stages, not just the default's.
   */
  allKeys(): string[];
}

/**
 * Build the resolver for a workspace. Two small indexed reads, run in parallel;
 * call it once per store operation and pass the result down rather than
 * resolving per row.
 */
export async function doneStatusesIn(
  tx: Tx,
  workspaceId: string,
): Promise<DoneStatuses> {
  const [stageRows, repoRows] = await Promise.all([
    tx
      .select({
        productId: workspaceStatuses.productId,
        key: workspaceStatuses.key,
      })
      .from(workspaceStatuses)
      .where(eq(workspaceStatuses.workspaceId, workspaceId))
      .orderBy(asc(workspaceStatuses.position)),
    tx
      .select({ config: repositories.config })
      .from(repositories)
      .where(eq(repositories.workspaceId, workspaceId)),
  ]);
  return doneStatusesFrom(stageRows, repoRows);
}

/**
 * The pure half of {@link doneStatusesIn}, so the resolution rules can be tested
 * without a database and reused by any caller that already holds the rows.
 */
export function doneStatusesFrom(
  stageRows: readonly { productId: string | null; key: string }[],
  repoRows: readonly { config: unknown }[],
): DoneStatuses {
  const byProduct = new Map<string, string[]>();
  const workspaceDefault: string[] = [];
  for (const row of stageRows) {
    if (row.productId === null) workspaceDefault.push(row.key);
    else {
      const own = byProduct.get(row.productId) ?? [];
      own.push(row.key);
      byProduct.set(row.productId, own);
    }
  }

  // The config's vocabulary only matters when nothing is configured in the DB,
  // matching how `resolveWorkflowFor` layers the two.
  let configStatuses: readonly string[] = [];
  for (const row of repoRows) {
    const config = safeParseRepoConfig(row.config);
    if (config?.statuses && config.statuses.length >= 2) {
      configStatuses = config.statuses;
      break;
    }
  }

  const fallback =
    terminalStatus(workspaceDefault) ??
    terminalStatus(configStatuses) ??
    terminalStatus(DEFAULT_STATUSES)!;
  const resolved = new Map<string, string>();
  for (const [productId, keys] of byProduct) {
    resolved.set(productId, terminalStatus(keys) ?? fallback);
  }

  const keyFor = (productId?: string | null): string =>
    (productId ? resolved.get(productId) : undefined) ?? fallback;
  const allKeys = [...new Set([fallback, ...resolved.values()])];
  return {
    keyFor,
    isDone: (status, productId) => status === keyFor(productId),
    allKeys: () => [...allKeys],
  };
}
