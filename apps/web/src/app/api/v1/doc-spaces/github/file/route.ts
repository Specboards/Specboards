import { canWriteProduct } from "@specboards/core";
import { GitWriteConflictError } from "@specboards/git";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { parseDocArea } from "@/lib/docs-service";
import {
  deleteGithubDocFile,
  renameGithubDocFile,
  saveGithubDocFile,
  validateDocPath,
} from "@/lib/github-docs";
import { getStore } from "@/lib/store";
import {
  DocError,
  ProductError,
  type DocSpace,
  type WorkspaceScope,
} from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** The parts every file operation shares once the request is authorized. */
interface FileRequestContext {
  scope: WorkspaceScope;
  space: DocSpace;
  body: Record<string, unknown>;
}

/**
 * Authorize the request, parse the shared body fields (productId, area), and
 * resolve the doc space with product-write access enforced. Returns a Response
 * on any failure so handlers can return it straight through.
 */
async function resolveFileRequest(
  req: Request,
): Promise<FileRequestContext | Response> {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) {
    return Response.json(
      { error: "GitHub-backed docs need a database-backed deployment." },
      { status: 501 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.productId !== "string") {
    return Response.json({ error: "productId is required." }, { status: 422 });
  }

  const area = parseDocArea(b.area);
  const store = await getStore();
  // getDocSpace enforces product visibility; editing needs product write.
  const space = await store.getDocSpace(b.productId, area, authz.scope);
  const access = await store.getProductAccess(authz.scope);
  if (!access.isOrgAdmin && !canWriteProduct(access, b.productId)) {
    return Response.json(
      { error: "Your role does not permit editing these docs." },
      { status: 403 },
    );
  }
  return { scope: authz.scope, space, body: b };
}

/** Map the domain errors every handler can raise onto responses. */
function errorResponse(err: unknown): Response {
  if (err instanceof GitWriteConflictError) {
    return Response.json(
      {
        error:
          "This page changed on GitHub since you loaded it. Reload the page to pick up the latest version, then reapply your edit.",
      },
      { status: 409 },
    );
  }
  if (err instanceof DocError || err instanceof ProductError) {
    return Response.json({ error: err.message }, { status: 422 });
  }
  throw err;
}

/**
 * PUT /api/v1/doc-spaces/github/file: save one Markdown file in a
 * GitHub-backed doc area; the save commits directly to the repo's default
 * branch. Body: { productId, area, path, content, blobSha }. `blobSha` is the
 * concurrent-edit guard: the sha the file had when loaded, or null for a new
 * page. A stale sha is a 409; reload and retry.
 */
export async function PUT(req: Request) {
  const ctx = await resolveFileRequest(req).catch(errorResponse);
  if (ctx instanceof Response) return ctx;
  const { space, scope, body } = ctx;
  const db = getDb();
  if (!db) return errorResponse(new DocError("Database unavailable."));

  if (typeof body.content !== "string") {
    return Response.json({ error: "content is required." }, { status: 422 });
  }
  if (typeof body.blobSha !== "string" && body.blobSha !== null) {
    return Response.json(
      {
        error: "blobSha is required (the loaded sha, or null for a new page).",
      },
      { status: 422 },
    );
  }

  try {
    const path = validateDocPath(body.path);
    const { commitSha, blobSha } = await saveGithubDocFile(
      db,
      scope.workspaceId,
      space,
      path,
      body.content,
      body.blobSha,
    );
    return Response.json({ ok: true, path, commitSha, blobSha });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/v1/doc-spaces/github/file: rename (or move) one Markdown file.
 * Body: { productId, area, path, toPath }. Commits the content at the new
 * path, then deletes the old file; returns the new file's sha + content.
 */
export async function PATCH(req: Request) {
  const ctx = await resolveFileRequest(req).catch(errorResponse);
  if (ctx instanceof Response) return ctx;
  const { space, scope, body } = ctx;
  const db = getDb();
  if (!db) return errorResponse(new DocError("Database unavailable."));

  try {
    const fromPath = validateDocPath(body.path);
    const toPath = validateDocPath(body.toPath);
    if (fromPath === toPath) {
      throw new DocError("The new path matches the current one.");
    }
    const { blobSha, content } = await renameGithubDocFile(
      db,
      scope.workspaceId,
      space,
      fromPath,
      toPath,
    );
    return Response.json({ ok: true, path: toPath, blobSha, content });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/v1/doc-spaces/github/file: delete one Markdown file with a
 * commit. Body: { productId, area, path, blobSha }. Guarded by the loaded
 * sha so a page someone just changed is not silently destroyed.
 */
export async function DELETE(req: Request) {
  const ctx = await resolveFileRequest(req).catch(errorResponse);
  if (ctx instanceof Response) return ctx;
  const { space, scope, body } = ctx;
  const db = getDb();
  if (!db) return errorResponse(new DocError("Database unavailable."));

  if (typeof body.blobSha !== "string") {
    return Response.json({ error: "blobSha is required." }, { status: 422 });
  }

  try {
    const path = validateDocPath(body.path);
    await deleteGithubDocFile(db, scope.workspaceId, space, path, body.blobSha);
    return Response.json({ ok: true, path });
  } catch (err) {
    return errorResponse(err);
  }
}
