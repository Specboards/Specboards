import { canWriteProduct } from "@specboards/core";

import { getDb } from "@/lib/db";
import {
  createDocPage,
  deleteDocPage,
  getDocSpace,
  listDocPages,
  parseDocArea,
  setDocSpace,
  updateDocPage,
} from "@/lib/docs-service";
import {
  deleteGithubDocFile,
  loadGithubDocs,
  readGithubDocFile,
  renameGithubDocFile,
  saveGithubDocFile,
  validateDocPath,
} from "@/lib/github-docs";
import { getStore } from "@/lib/store";
import {
  DocError,
  type DocArea,
  type DocPageRecord,
  type DocSpace,
} from "@/lib/store/types";

import { requireString, type McpContext, type McpTool } from "./types";

/**
 * MCP tools for the Plan-section doc areas: Strategy, Research, and
 * Architecture. These are the narrative half of the product plan (why the
 * product exists, what discovery found, how the system is built), as opposed
 * to the work items `tools.ts` covers.
 *
 * One set of tools serves every backing an area can have, because which one a
 * team picked is a setup detail an agent should not have to reason about:
 *
 *  - `local`  - pages Specboards holds, edited through the store (the default,
 *               and the only option for Strategy).
 *  - `github` - Markdown files in a connected repo, edited with a commit. The
 *               page id IS the repo-relative path.
 *  - `external` - the area links out (SharePoint, Notion, ...). Readable as a
 *               link; there is nothing here to edit.
 *  - `unset`  - nobody has chosen yet. Creating the first page adopts `local`,
 *               so the page the agent just wrote is actually visible in the app
 *               rather than hidden behind the source chooser.
 */

/** Shared JSON Schema fragments; every doc tool is addressed the same way. */
const productSchema = {
  type: "string",
  description: "Owning product, by key (see list_products). Docs are per product.",
} as const;

const areaSchema = {
  type: "string",
  enum: ["strategy", "research", "architecture"],
  description:
    "Which doc area: strategy (why the product exists and the current " +
    "targets), research (discovery, interviews, synthesis), or architecture " +
    "(engineering constitution, service boundaries, contracts).",
} as const;

const docIdSchema = {
  type: "string",
  description:
    "The page's id from list_docs. For a Specboards-held area that is a " +
    "UUID; for a GitHub-backed area it is the repo-relative file path.",
} as const;

/** Resolve a product key to its id, with an error naming the bad key. */
async function resolveProductId(
  ctx: McpContext,
  args: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const key = requireString(args, "product");
  const store = await getStore();
  const products = await store.listProducts(ctx.scope);
  const match = products.find((p) => p.key === key);
  if (!match) throw new Error(`No product with key "${key}".`);
  return { id: match.id, key: match.key };
}

/** The product + area + source every doc tool resolves before doing anything. */
interface DocTarget {
  productId: string;
  productKey: string;
  area: DocArea;
  space: DocSpace;
}

async function resolveTarget(
  ctx: McpContext,
  args: Record<string, unknown>,
): Promise<DocTarget> {
  const product = await resolveProductId(ctx, args);
  const area = parseDocArea(args.area);
  // getDocSpace enforces the caller's read access to the product.
  const space = await getDocSpace(product.id, area, ctx.scope);
  return { productId: product.id, productKey: product.key, area, space };
}

/**
 * Editing an area's docs follows the product's write permission. The store
 * enforces this for Specboards-held pages; GitHub-backed writes go straight to
 * the repo helpers, so check it here exactly as /api/v1/doc-spaces/github/file
 * does before committing anything.
 */
async function requireProductWrite(
  ctx: McpContext,
  productId: string,
): Promise<void> {
  if (ctx.isLocal || !ctx.scope) return;
  const store = await getStore();
  const access = await store.getProductAccess(ctx.scope);
  if (!access.isOrgAdmin && !canWriteProduct(access, productId)) {
    throw new Error("Your role does not permit editing these docs.");
  }
}

/** GitHub-backed docs commit to a repo, which needs the DB-backed deployment. */
function requireGithubDeps(ctx: McpContext) {
  const db = getDb();
  if (!db || !ctx.scope) {
    throw new Error(
      "GitHub-backed docs need a database-backed deployment with a connected " +
        "repository; they are unavailable in local file mode.",
    );
  }
  return { db, workspaceId: ctx.scope.workspaceId };
}

/** Refuse writes to an area that only links out; there is nothing to edit. */
function refuseExternal(target: DocTarget): void {
  if (target.space.mode === "external") {
    throw new Error(
      `The ${target.area} area for "${target.productKey}" links out to ` +
        `${target.space.externalUrl ?? "an external repository"}; Specboards ` +
        "does not hold its pages, so there is nothing to edit here.",
    );
  }
}

/**
 * A title turned into a repo-relative Markdown path, for a GitHub-backed area
 * where the caller gave a title rather than a path. Keeps within what
 * `validateDocPath` accepts.
 */
function pathFromTitle(title: string, folder: string | null): string {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "page";
  const file = `${slug}.md`;
  return validateDocPath(folder ? `${folder}/${file}` : file);
}

/** The folder part of a repo path, or null at the repo root. */
function folderOf(path: string): string | null {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? null : path.slice(0, cut);
}

/** A repo file's display title: its basename without the .md extension. */
function titleOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

/** Project a Specboards-held page down to the fields the MCP surface returns. */
function localPageOut(page: DocPageRecord) {
  return {
    docId: page.id,
    kind: page.kind,
    title: page.title,
    parentId: page.parentId,
    contentChars: page.content.length,
    updatedAt: page.updatedAt,
  };
}

/** The area's source, described for an agent rather than for the setup UI. */
function sourceOut(space: DocSpace) {
  return {
    mode: space.mode,
    externalUrl: space.externalUrl,
    repoId: space.repoId,
  };
}

/** Find one Specboards-held page by id within its area. */
async function findLocalPage(
  target: DocTarget,
  docId: string,
  ctx: McpContext,
): Promise<DocPageRecord> {
  const pages = await listDocPages(target.productId, target.area, ctx.scope);
  const page = pages.find((p) => p.id === docId);
  if (!page) {
    throw new DocError(
      `No page with id ${docId} in the ${target.area} area for ` +
        `"${target.productKey}".`,
    );
  }
  return page;
}

export const DOC_TOOLS: McpTool[] = [
  {
    name: "list_docs",
    description:
      "List the pages in a product's Strategy, Research, or Architecture " +
      "area: the narrative plan (why the product exists, what discovery " +
      "found, how the system is built) that the work items in list_items " +
      "deliver. Returns the area's `source` and a flat list of folders and " +
      "pages with their `docId`; nesting is `parentId` for Specboards-held " +
      "pages and the path for GitHub-backed ones. Bodies are omitted (see " +
      "`contentChars`) - call read_doc for one page's Markdown. An area whose " +
      "source is `external` has no pages here, only the link to follow; one " +
      "that is `unset` is empty until the first create_doc adopts it.",
    inputSchema: {
      type: "object",
      properties: { product: productSchema, area: areaSchema },
      required: ["product", "area"],
      additionalProperties: false,
    },
    write: false,
    scope: { resource: "docs", action: "read" },
    run: async (args, ctx) => {
      const target = await resolveTarget(ctx, args);
      const base = {
        product: target.productKey,
        area: target.area,
        source: sourceOut(target.space),
      };
      if (target.space.mode === "external") {
        return { ...base, pages: [] };
      }
      if (target.space.mode === "github") {
        const { db, workspaceId } = requireGithubDeps(ctx);
        const { repo, files } = await loadGithubDocs(
          db,
          workspaceId,
          target.space,
        );
        return {
          ...base,
          repo: { fullName: `${repo.owner}/${repo.name}`, url: repo.htmlUrl },
          pages: files.map((f) => ({
            docId: f.path,
            kind: "page" as const,
            title: titleOfPath(f.path),
            folder: folderOf(f.path),
            contentChars: f.content.length,
          })),
        };
      }
      const pages = await listDocPages(target.productId, target.area, ctx.scope);
      return { ...base, pages: pages.map(localPageOut) };
    },
  },
  {
    name: "read_doc",
    description:
      "Read one Strategy / Research / Architecture page in full, including " +
      "its Markdown body. Pass the `docId` from list_docs. Folders have no " +
      "body of their own; read their pages instead.",
    inputSchema: {
      type: "object",
      properties: {
        product: productSchema,
        area: areaSchema,
        docId: docIdSchema,
      },
      required: ["product", "area", "docId"],
      additionalProperties: false,
    },
    write: false,
    scope: { resource: "docs", action: "read" },
    run: async (args, ctx) => {
      const target = await resolveTarget(ctx, args);
      const docId = requireString(args, "docId");
      if (target.space.mode === "external") {
        throw new Error(
          `The ${target.area} area for "${target.productKey}" links out to ` +
            `${target.space.externalUrl ?? "an external repository"}; its ` +
            "pages are not readable through Specboards.",
        );
      }
      if (target.space.mode === "github") {
        const { db, workspaceId } = requireGithubDeps(ctx);
        const file = await readGithubDocFile(
          db,
          workspaceId,
          target.space,
          validateDocPath(docId),
        );
        return {
          product: target.productKey,
          area: target.area,
          docId: file.path,
          kind: "page" as const,
          title: titleOfPath(file.path),
          folder: folderOf(file.path),
          content: file.content,
        };
      }
      const page = await findLocalPage(target, docId, ctx);
      return {
        product: target.productKey,
        area: target.area,
        ...localPageOut(page),
        content: page.content,
      };
    },
  },
  {
    name: "create_doc",
    description:
      "Create a page (or a folder) in a product's Strategy, Research, or " +
      "Architecture area - for example writing up the research behind an " +
      "initiative, or an architecture note the specs then implement. Provide " +
      "`product`, `area` and `title`; optionally `kind` ('page', the default, " +
      "or 'folder'), `parentId` to nest it under a folder, and `content` " +
      "(Markdown). On a GitHub-backed area this commits a Markdown file: pass " +
      "`path` for an exact repo-relative path, or let it be derived from the " +
      "title. An area with no source chosen yet becomes Specboards-held, so " +
      "the page is visible in the app immediately (the response reports this " +
      "as `sourceInitialized`).",
    inputSchema: {
      type: "object",
      properties: {
        product: productSchema,
        area: areaSchema,
        title: { type: "string" },
        kind: {
          type: "string",
          enum: ["page", "folder"],
          description:
            "Default 'page'. Folders only exist in Specboards-held areas; a " +
            "GitHub-backed area gets its folders from the file path.",
        },
        parentId: {
          type: ["string", "null"],
          description:
            "Containing folder's docId (Specboards-held areas), or null for " +
            "the area root.",
        },
        content: {
          type: ["string", "null"],
          description: "Markdown body. Ignored for a folder.",
        },
        path: {
          type: "string",
          description:
            "GitHub-backed areas only: the repo-relative .md path to commit " +
            "(e.g. 'discovery/interviews.md'). Derived from the title if omitted.",
        },
      },
      required: ["product", "area", "title"],
      additionalProperties: false,
    },
    write: true,
    // Only for a GitHub-backed area: see McpTool.commits.
    commits: true,
    scope: { resource: "docs", action: "write" },
    run: async (args, ctx) => {
      const target = await resolveTarget(ctx, args);
      const title = requireString(args, "title");
      refuseExternal(target);
      await requireProductWrite(ctx, target.productId);
      const content = typeof args.content === "string" ? args.content : "";

      if (target.space.mode === "github") {
        if (args.kind === "folder") {
          throw new DocError(
            "A GitHub-backed area has no folder records: commit a page at a " +
              "path instead (e.g. 'discovery/interviews.md').",
          );
        }
        const { db, workspaceId } = requireGithubDeps(ctx);
        const path =
          typeof args.path === "string" && args.path.trim()
            ? validateDocPath(args.path)
            : pathFromTitle(title, null);
        const { blobSha } = await saveGithubDocFile(
          db,
          workspaceId,
          target.space,
          path,
          content,
          // Create-guarded: a non-null sha would be an edit, and null makes
          // GitHub reject the write if something already lives at this path.
          null,
        );
        return {
          product: target.productKey,
          area: target.area,
          docId: path,
          kind: "page" as const,
          title: titleOfPath(path),
          folder: folderOf(path),
          blobSha,
          sourceInitialized: false,
        };
      }

      // `unset` means nobody has picked a source. Adopt Specboards-held pages,
      // or the page would exist but stay hidden behind the setup chooser.
      const sourceInitialized = target.space.mode === "unset";
      if (sourceInitialized) {
        await setDocSpace(
          target.productId,
          target.area,
          { mode: "local" },
          ctx.scope,
        );
      }
      const page = await createDocPage(
        {
          productId: target.productId,
          area: target.area,
          title,
          kind: args.kind === "folder" ? "folder" : "page",
          parentId: typeof args.parentId === "string" ? args.parentId : null,
          content,
        },
        ctx.scope,
      );
      return {
        product: target.productKey,
        area: target.area,
        ...localPageOut(page),
        sourceInitialized,
      };
    },
  },
  {
    name: "update_doc",
    description:
      "Update a Strategy / Research / Architecture page: rewrite its " +
      "`content` (the full new Markdown body, not a fragment), rename it with " +
      "`title`, or move it with `parentId` (a folder's docId, or null for the " +
      "area root). Pass the `docId` from list_docs; at least one change is " +
      "required. On a GitHub-backed area each call commits to the repo, a " +
      "rename moves the file (pass `path` to control the new path exactly), " +
      "and the write is rejected if the file changed underneath you - reread " +
      "with read_doc and reapply.",
    inputSchema: {
      type: "object",
      properties: {
        product: productSchema,
        area: areaSchema,
        docId: docIdSchema,
        title: { type: "string", description: "New title." },
        content: {
          type: "string",
          description: "The full new Markdown body.",
        },
        parentId: {
          type: ["string", "null"],
          description:
            "Specboards-held areas: move under this folder's docId, or null " +
            "for the area root.",
        },
        path: {
          type: "string",
          description:
            "GitHub-backed areas: move or rename the file to this " +
            "repo-relative .md path.",
        },
      },
      required: ["product", "area", "docId"],
      additionalProperties: false,
    },
    write: true,
    // Only for a GitHub-backed area: see McpTool.commits.
    commits: true,
    scope: { resource: "docs", action: "write" },
    run: async (args, ctx) => {
      const target = await resolveTarget(ctx, args);
      const docId = requireString(args, "docId");
      refuseExternal(target);
      await requireProductWrite(ctx, target.productId);
      const hasTitle = typeof args.title === "string";
      const hasContent = typeof args.content === "string";

      if (target.space.mode === "github") {
        const { db, workspaceId } = requireGithubDeps(ctx);
        const fromPath = validateDocPath(docId);
        const toPath =
          typeof args.path === "string" && args.path.trim()
            ? validateDocPath(args.path)
            : hasTitle
              ? pathFromTitle(args.title as string, folderOf(fromPath))
              : fromPath;
        if (!hasContent && toPath === fromPath) {
          throw new DocError("Nothing to update.");
        }
        // Rename first so the content write lands at the final path; the
        // rename hands back the sha the write then guards against.
        let path = fromPath;
        let blobSha: string | null = null;
        if (toPath !== fromPath) {
          const renamed = await renameGithubDocFile(
            db,
            workspaceId,
            target.space,
            fromPath,
            toPath,
          );
          path = toPath;
          blobSha = renamed.blobSha;
        }
        if (hasContent) {
          if (blobSha === null) {
            const current = await readGithubDocFile(
              db,
              workspaceId,
              target.space,
              path,
            );
            blobSha = current.blobSha;
          }
          const saved = await saveGithubDocFile(
            db,
            workspaceId,
            target.space,
            path,
            args.content as string,
            blobSha,
          );
          blobSha = saved.blobSha;
        }
        return {
          product: target.productKey,
          area: target.area,
          docId: path,
          kind: "page" as const,
          title: titleOfPath(path),
          folder: folderOf(path),
          blobSha,
        };
      }

      const patch: {
        title?: string;
        content?: string;
        parentId?: string | null;
      } = {};
      if (hasTitle) patch.title = args.title as string;
      if (hasContent) patch.content = args.content as string;
      if (args.parentId !== undefined) {
        if (args.parentId !== null && typeof args.parentId !== "string") {
          throw new DocError("Invalid folder.");
        }
        patch.parentId = args.parentId as string | null;
      }
      if (Object.keys(patch).length === 0) {
        throw new DocError("Nothing to update.");
      }
      // Confirm the page really is in the area that was addressed, so a
      // mismatched product/docId pair fails here rather than editing a page
      // the response would then describe under the wrong product.
      const existing = await findLocalPage(target, docId, ctx);
      const page = await updateDocPage(existing.id, patch, ctx.scope);
      return {
        product: target.productKey,
        area: target.area,
        ...localPageOut(page),
      };
    },
  },
  {
    name: "delete_doc",
    description:
      "Delete a Strategy / Research / Architecture page. Deleting a folder " +
      "takes everything inside it with it, so that needs `deleteChildren: " +
      "true` - a deliberate second step, since the pages under a folder are " +
      "not visible in the delete call itself. On a GitHub-backed area this " +
      "commits the file's removal to the repo. Irreversible: confirm the " +
      "docId with read_doc first.",
    inputSchema: {
      type: "object",
      properties: {
        product: productSchema,
        area: areaSchema,
        docId: docIdSchema,
        deleteChildren: {
          type: "boolean",
          description:
            "Required to delete a folder that still has pages or folders in it.",
        },
      },
      required: ["product", "area", "docId"],
      additionalProperties: false,
    },
    write: true,
    // Only for a GitHub-backed area: see McpTool.commits.
    commits: true,
    destructive: true,
    scope: { resource: "docs", action: "write" },
    run: async (args, ctx) => {
      const target = await resolveTarget(ctx, args);
      const docId = requireString(args, "docId");
      refuseExternal(target);
      await requireProductWrite(ctx, target.productId);

      if (target.space.mode === "github") {
        const { db, workspaceId } = requireGithubDeps(ctx);
        const path = validateDocPath(docId);
        // Read first for the sha: the delete is guarded so a page someone just
        // changed is never silently destroyed.
        const current = await readGithubDocFile(
          db,
          workspaceId,
          target.space,
          path,
        );
        await deleteGithubDocFile(
          db,
          workspaceId,
          target.space,
          path,
          current.blobSha,
        );
        return {
          product: target.productKey,
          area: target.area,
          docId: path,
          title: titleOfPath(path),
          deleted: true,
          deletedChildren: 0,
        };
      }

      const pages = await listDocPages(target.productId, target.area, ctx.scope);
      const page = pages.find((p) => p.id === docId);
      if (!page) {
        throw new DocError(
          `No page with id ${docId} in the ${target.area} area for ` +
            `"${target.productKey}".`,
        );
      }
      // Count the whole subtree, not just direct children: the store cascades
      // the delete, so the agent should see everything it is about to remove.
      const descendants = new Set<string>();
      let frontier = [page.id];
      while (frontier.length) {
        const next = pages.filter(
          (p) => p.parentId !== null && frontier.includes(p.parentId),
        );
        frontier = [];
        for (const child of next) {
          if (descendants.has(child.id)) continue;
          descendants.add(child.id);
          frontier.push(child.id);
        }
      }
      if (descendants.size > 0 && args.deleteChildren !== true) {
        throw new DocError(
          `"${page.title}" contains ${descendants.size} page(s); pass ` +
            "deleteChildren: true to delete it and everything inside it.",
        );
      }
      await deleteDocPage(page.id, ctx.scope);
      return {
        product: target.productKey,
        area: target.area,
        docId: page.id,
        title: page.title,
        deleted: true,
        deletedChildren: descendants.size,
      };
    },
  },
];
