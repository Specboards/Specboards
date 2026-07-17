import {
  and,
  eq,
  inArray,
  productRepositories,
  products,
  repositories,
  type Database,
} from "@specboard/db";

import { InvalidPatchError } from "@/lib/features-service";

/**
 * Repo → product links (track B). Repositories aren't part of the store layer
 * (their routes hit drizzle directly, like github-sync), so this service does
 * too: callers pass the owner connection after route-level org-admin
 * authorization, mirroring /api/v1/repositories.
 */

/** One repo's product links as the settings UI consumes them. */
export interface RepoProductLinks {
  repoId: string;
  productIds: string[];
  /** The product sync assigns new specs to, or null when link-less (the
   * workspace default product applies then). */
  defaultProductId: string | null;
}

/** Raised when a link update is invalid (unknown repo/product, bad default). */
export class RepoLinkError extends Error {}

/** All repos' product links in the workspace, keyed by repo id. */
export async function listRepoProductLinks(
  db: Database,
  workspaceId: string,
): Promise<Map<string, RepoProductLinks>> {
  const rows = await db
    .select({
      repoId: productRepositories.repoId,
      productId: productRepositories.productId,
      isDefault: productRepositories.isDefault,
    })
    .from(productRepositories)
    .where(eq(productRepositories.workspaceId, workspaceId));
  const out = new Map<string, RepoProductLinks>();
  for (const row of rows) {
    const links =
      out.get(row.repoId) ??
      ({ repoId: row.repoId, productIds: [], defaultProductId: null } satisfies RepoProductLinks);
    out.set(row.repoId, links);
    links.productIds.push(row.productId);
    if (row.isDefault) links.defaultProductId = row.productId;
  }
  return out;
}

/** Parse and validate an untrusted set-links body. */
export function parseRepoProductsInput(body: unknown): {
  productIds: string[];
  defaultProductId: string | null;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (
    !Array.isArray(raw.productIds) ||
    raw.productIds.some((id) => typeof id !== "string")
  ) {
    throw new InvalidPatchError("productIds must be an array of product ids.");
  }
  const productIds = [...new Set(raw.productIds as string[])];
  let defaultProductId: string | null = null;
  if ("defaultProductId" in raw && raw.defaultProductId !== null) {
    if (typeof raw.defaultProductId !== "string") {
      throw new InvalidPatchError("defaultProductId must be a product id or null.");
    }
    defaultProductId = raw.defaultProductId;
  }
  if (defaultProductId && !productIds.includes(defaultProductId)) {
    throw new InvalidPatchError(
      "defaultProductId must be one of the linked productIds.",
    );
  }
  if (productIds.length > 0 && !defaultProductId) {
    throw new InvalidPatchError(
      "A repo with linked products needs a defaultProductId (where its new specs land).",
    );
  }
  return { productIds, defaultProductId };
}

/**
 * Replace a repo's product links transactionally: remove stale rows, insert
 * new ones, and point `isDefault` at `defaultProductId`. An empty `productIds`
 * clears all links (sync falls back to the workspace default product).
 */
export async function setRepoProducts(
  db: Database,
  workspaceId: string,
  repoId: string,
  input: { productIds: string[]; defaultProductId: string | null },
): Promise<RepoProductLinks> {
  return db.transaction(async (tx) => {
    const repo = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(eq(repositories.id, repoId), eq(repositories.workspaceId, workspaceId)),
      )
      .limit(1);
    if (!repo[0]) throw new RepoLinkError("Repository not found in your workspace.");

    if (input.productIds.length > 0) {
      const known = await tx
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.workspaceId, workspaceId),
            inArray(products.id, input.productIds),
          ),
        );
      if (known.length !== input.productIds.length) {
        throw new RepoLinkError("One or more products are not in this workspace.");
      }
    }

    // Clear the old default before re-inserting so the partial unique index
    // (one default per repo) never sees two defaults mid-transaction.
    await tx
      .delete(productRepositories)
      .where(eq(productRepositories.repoId, repoId));
    if (input.productIds.length > 0) {
      await tx.insert(productRepositories).values(
        input.productIds.map((productId) => ({
          workspaceId,
          repoId,
          productId,
          isDefault: productId === input.defaultProductId,
        })),
      );
    }
    return {
      repoId,
      productIds: input.productIds,
      defaultProductId: input.defaultProductId,
    };
  });
}
