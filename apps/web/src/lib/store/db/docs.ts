/**
 * Docs: the free-form pages that hang off a product's Plan sections.
 *
 * The only domain whose authorization is a two-step: `requireDocRead` proves
 * the product exists and is visible, `requireDocWrite` adds the role check on
 * top of it. They are separate because a doc space is readable by anyone who
 * can see the product but editable only by someone who can write to it, and
 * folding them together would silently upgrade one to the other.
 *
 * That read check is why this module needs `productVisibilityIn`: `accessIn`
 * says what the caller may reach, `productVisibilityIn` says what there is to
 * reach, and `canReadProductId` needs both.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import {
  and,
  asc,
  count,
  docPages,
  docSpaces,
  eq,
  repositories,
} from "@specboards/db";

import {
  DocError,
  validateExternalDocUrl,
  type DocArea,
  type DocPageInput,
  type DocPagePatch,
  type DocPageRecord,
  type DocSpace,
  type DocSpaceInput,
  type WorkspaceScope,
} from "../types";

import {
  canReadProductId,
  canWriteProductId,
  type DbStoreContext,
  type Tx,
} from "./context";

export async function getDocSpace(
  ctx: DbStoreContext,
  productId: string,
  area: DocArea,
  scope?: WorkspaceScope,
): Promise<DocSpace> {
  return ctx.scoped(scope, async (tx) => {
    await requireDocRead(ctx, tx, scope!, productId);
    const [row] = await tx
      .select()
      .from(docSpaces)
      .where(and(eq(docSpaces.productId, productId), eq(docSpaces.area, area)))
      .limit(1);
    if (!row)
      return {
        productId,
        area,
        mode: "unset" as const,
        externalUrl: null,
        repoId: null,
      };
    return {
      productId,
      area,
      mode: row.mode as DocSpace["mode"],
      externalUrl: row.externalUrl,
      repoId: row.repoId,
    };
  });
}

export async function setDocSpace(
  ctx: DbStoreContext,
  productId: string,
  area: DocArea,
  input: DocSpaceInput,
  scope?: WorkspaceScope,
): Promise<DocSpace> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    await requireDocWrite(ctx, tx, scope!, productId);
    let externalUrl: string | null = null;
    let repoId: string | null = null;
    if (input.mode === "external") {
      externalUrl = validateExternalDocUrl(input.externalUrl);
    } else if (input.mode === "github") {
      if (!input.repoId) throw new DocError("Choose a repository.");
      const [repo] = await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.id, input.repoId),
            eq(repositories.workspaceId, ws),
          ),
        )
        .limit(1);
      if (!repo) throw new DocError("Unknown repository.");
      repoId = repo.id;
    }
    await tx
      .insert(docSpaces)
      .values({
        workspaceId: ws,
        productId,
        area,
        mode: input.mode,
        externalUrl,
        repoId,
      })
      .onConflictDoUpdate({
        target: [docSpaces.productId, docSpaces.area],
        set: { mode: input.mode, externalUrl, repoId, updatedAt: new Date() },
      });
    return { productId, area, mode: input.mode, externalUrl, repoId };
  });
}

export async function listDocPages(
  ctx: DbStoreContext,
  productId: string,
  area: DocArea,
  scope?: WorkspaceScope,
): Promise<DocPageRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    await requireDocRead(ctx, tx, scope!, productId);
    const rows = await tx
      .select()
      .from(docPages)
      .where(and(eq(docPages.productId, productId), eq(docPages.area, area)))
      .orderBy(asc(docPages.position), asc(docPages.title));
    return rows.map((r) => toDocPageRecord(r));
  });
}

export async function createDocPage(
  ctx: DbStoreContext,
  input: DocPageInput,
  scope?: WorkspaceScope,
): Promise<DocPageRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    await requireDocWrite(ctx, tx, scope!, input.productId);
    const title = input.title.trim();
    if (!title) throw new DocError("A title is required.");
    const parentId = input.parentId ?? null;
    if (parentId) {
      await requireDocFolder(tx, parentId, input.productId, input.area);
    }
    const [max] = await tx
      .select({ n: count() })
      .from(docPages)
      .where(
        and(
          eq(docPages.productId, input.productId),
          eq(docPages.area, input.area),
        ),
      );
    const [row] = await tx
      .insert(docPages)
      .values({
        workspaceId: ws,
        productId: input.productId,
        area: input.area,
        parentId,
        kind: input.kind === "folder" ? "folder" : "page",
        title,
        content: input.content ?? "",
        position: Number(max?.n ?? 0),
      })
      .returning();
    if (!row) throw new DocError("Failed to create the page.");
    return toDocPageRecord(row);
  });
}

export async function updateDocPage(
  ctx: DbStoreContext,
  id: string,
  patch: DocPagePatch,
  scope?: WorkspaceScope,
): Promise<DocPageRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [current] = await tx
      .select()
      .from(docPages)
      .where(and(eq(docPages.id, id), eq(docPages.workspaceId, ws)))
      .limit(1);
    if (!current) throw new DocError(`Unknown page: ${id}`);
    await requireDocWrite(ctx, tx, scope!, current.productId);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new DocError("A title is required.");
      set.title = title;
    }
    if (patch.content !== undefined) {
      if (current.kind === "folder") {
        throw new DocError("Folders have no content.");
      }
      set.content = patch.content;
    }
    if (patch.parentId !== undefined) {
      if (patch.parentId === null) {
        set.parentId = null;
      } else {
        if (patch.parentId === id) {
          throw new DocError("A folder cannot contain itself.");
        }
        await requireDocFolder(
          tx,
          patch.parentId,
          current.productId,
          current.area as DocArea,
        );
        // Refuse moving a folder under its own descendant (would orphan the
        // subtree into a cycle).
        if (current.kind === "folder") {
          let cursor: string | null = patch.parentId;
          while (cursor) {
            const [anc] = await tx
              .select({ parentId: docPages.parentId })
              .from(docPages)
              .where(eq(docPages.id, cursor))
              .limit(1);
            const next: string | null = anc?.parentId ?? null;
            if (next === id) {
              throw new DocError("A folder cannot move inside itself.");
            }
            cursor = next;
          }
        }
        set.parentId = patch.parentId;
      }
    }
    await tx
      .update(docPages)
      .set(set)
      .where(and(eq(docPages.id, id), eq(docPages.workspaceId, ws)));
    const [row] = await tx
      .select()
      .from(docPages)
      .where(eq(docPages.id, id))
      .limit(1);
    if (!row) throw new DocError(`Unknown page: ${id}`);
    return toDocPageRecord(row);
  });
}

export async function deleteDocPage(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [current] = await tx
      .select({ productId: docPages.productId })
      .from(docPages)
      .where(and(eq(docPages.id, id), eq(docPages.workspaceId, ws)))
      .limit(1);
    if (!current) throw new DocError(`Unknown page: ${id}`);
    await requireDocWrite(ctx, tx, scope!, current.productId);
    // Children cascade on the parent FK.
    await tx
      .delete(docPages)
      .where(and(eq(docPages.id, id), eq(docPages.workspaceId, ws)));
  });
}

/** Assert the acting user can read `productId`'s docs, returning nothing. */
async function requireDocRead(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
  productId: string,
): Promise<void> {
  await ctx.requireProductId(tx, scope.workspaceId, productId);
  const [access, productById] = await Promise.all([
    ctx.accessIn(tx, scope),
    ctx.productVisibilityIn(tx, scope.workspaceId),
  ]);
  if (!canReadProductId(access, productById, productId)) {
    throw new DocError("Unknown product.");
  }
}

/** Assert the acting user can edit `productId`'s docs. */
async function requireDocWrite(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
  productId: string,
): Promise<void> {
  await requireDocRead(ctx, tx, scope, productId);
  const access = await ctx.accessIn(tx, scope);
  if (!canWriteProductId(access, productId)) {
    throw new DocError("Your role does not permit editing these docs.");
  }
}

/** Assert `folderId` is a folder in the same product + area. */
async function requireDocFolder(
  tx: Tx,
  folderId: string,
  productId: string,
  area: DocArea,
): Promise<void> {
  const [row] = await tx
    .select({ kind: docPages.kind })
    .from(docPages)
    .where(
      and(
        eq(docPages.id, folderId),
        eq(docPages.productId, productId),
        eq(docPages.area, area),
      ),
    )
    .limit(1);
  if (!row) throw new DocError("Unknown folder.");
  if (row.kind !== "folder") throw new DocError("Pages cannot contain pages.");
}

function toDocPageRecord(row: typeof docPages.$inferSelect): DocPageRecord {
  return {
    id: row.id,
    productId: row.productId,
    area: row.area as DocArea,
    parentId: row.parentId,
    kind: row.kind === "folder" ? "folder" : "page",
    title: row.title,
    content: row.content,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
