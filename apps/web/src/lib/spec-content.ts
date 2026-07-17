import { randomUUID } from "node:crypto";

import { canWriteProduct, rewriteSpecBody } from "@specboard/core";
import {
  and,
  eq,
  features,
  repositories,
  specIndex,
  type Database,
} from "@specboard/db";

import {
  featureSlug,
  resolveRepoClient,
  resolveRepoDefaultProduct,
  syncRepository,
  type RepoRecord,
} from "@/lib/github-sync";
import { getStore, type WorkspaceScope } from "@/lib/store";

/**
 * Writing a spec's Markdown means committing to the connected GitHub repo (git
 * is canonical; `spec_index` is a cache). These operations therefore live
 * alongside the sync in `github-sync.ts`, not in the store, and run on the
 * owner DB connection - but only after the caller's read + product-write access
 * has been verified through the RLS-enforced store. That keeps agents from
 * reaching specs their role can't touch even though the git write bypasses RLS.
 */

/** Raised when a spec can't be written (no repo, no access, name clash, ...). */
export class SpecContentError extends Error {}

/** The feature's git pointers, resolved on the owner connection. */
interface SpecGitTarget {
  repo: RepoRecord;
  path: string;
  title: string;
}

/**
 * Confirm the caller may write the spec `specId`, then resolve its repo + path.
 * Read access is checked through the store (RLS); product-write is checked
 * explicitly because the git write below uses the owner connection.
 */
async function authorizeSpecWrite(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<SpecGitTarget> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new SpecContentError(`No item with spec id ${specId}.`);
  if (feature.isDbNative) {
    throw new SpecContentError(
      "This is a DB-native card, not a git-backed spec. Edit its body with " +
        "update_item (details) instead.",
    );
  }
  const access = await store.getProductAccess(scope);
  const allowed =
    feature.productId === null
      ? access.isOrgAdmin
      : canWriteProduct(access, feature.productId);
  if (!allowed) {
    throw new SpecContentError("Your role does not permit editing this spec.");
  }

  const [row] = await db
    .select({
      repoId: features.repoId,
      path: specIndex.path,
    })
    .from(features)
    .leftJoin(specIndex, eq(specIndex.featureId, features.id))
    .where(
      and(
        eq(features.specId, specId),
        eq(features.workspaceId, scope.workspaceId),
      ),
    )
    .limit(1);
  if (!row?.repoId || !row.path) {
    throw new SpecContentError(
      "This spec has no connected repository file to edit.",
    );
  }
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, row.repoId))
    .limit(1);
  if (!repo) {
    throw new SpecContentError("The spec's repository is no longer connected.");
  }
  return { repo, path: row.path, title: feature.title };
}

export interface SpecWriteResult {
  specId: string;
  path: string;
  commitSha: string;
}

/**
 * Replace an existing spec's Markdown body, preserving its frontmatter (and so
 * its stable `id`), commit it to the repo's default branch, and re-sync so the
 * board reflects the change. `body` is the Markdown after the frontmatter, as
 * returned by read_item's `content`.
 */
export async function updateSpecContent(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  body: string,
  opts: { message?: string } = {},
): Promise<SpecWriteResult> {
  const { repo, path, title } = await authorizeSpecWrite(db, scope, specId);
  const client = await resolveRepoClient(db, repo);
  const existing = await client.readFile(path);
  const content = rewriteSpecBody(existing.raw, body, { id: specId, title });
  const { commitSha } = await client.writeFile({
    path,
    content,
    message: opts.message?.trim() || `docs(specboard): update ${path}`,
    mode: "direct",
  });
  await syncRepository(db, repo);
  return { specId, path, commitSha };
}

/** The spec file body committed for a brand-new spec (fresh id in frontmatter). */
function newSpecFile(id: string, title: string, body: string | undefined): string {
  const trimmed = (body ?? "").trim();
  const content = trimmed || `# ${title}\n\nDescribe this spec.`;
  // JSON-quote the title (valid YAML) so names with colons stay parseable.
  return `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\nkind: feature\n---\n\n${content}\n`;
}

/**
 * Create a new leaf spec file in a connected repo, commit it, and sync so a
 * card appears on the board. Returns the new spec's id (generated up front, so
 * it is known before the sync). Callers that want the spec parented under a
 * particular card follow up with an update_item on `parentSpecId` - this keeps
 * the git write focused and lets the store enforce the hierarchy rules.
 */
export async function createSpec(
  db: Database,
  scope: WorkspaceScope,
  input: { title: string; body?: string; repoId?: string; message?: string },
): Promise<SpecWriteResult> {
  const title = input.title.trim();
  if (!title) throw new SpecContentError("title is required.");
  const slug = featureSlug(title);
  if (!slug) {
    throw new SpecContentError(
      "Give the spec a title with at least one letter or number.",
    );
  }

  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, scope.workspaceId));
  if (repos.length === 0) {
    throw new SpecContentError(
      "No connected repository. Connect a GitHub spec repo first.",
    );
  }
  let repo: RepoRecord;
  if (input.repoId) {
    const found = repos.find((r) => r.id === input.repoId);
    if (!found) {
      throw new SpecContentError("Repository not found in your workspace.");
    }
    repo = found;
  } else {
    // Prefer the designated spec repo, else the first connected repo.
    repo = repos.find((r) => r.isSpecRepo) ?? repos[0]!;
  }

  // New specs sync into the target repo's default product; require write there.
  const store = await getStore();
  const access = await store.getProductAccess(scope);
  const defaultProductId = await resolveRepoDefaultProduct(db, repo);
  if (!access.isOrgAdmin && !canWriteProduct(access, defaultProductId)) {
    throw new SpecContentError(
      "Your role does not permit creating specs in this workspace.",
    );
  }

  const client = await resolveRepoClient(db, repo);
  const path = `specs/${slug}/spec.md`;
  let exists = false;
  try {
    await client.readFile(path);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    throw new SpecContentError(
      `${path} already exists in ${repo.owner}/${repo.name}. Pick a different title.`,
    );
  }

  const id = randomUUID();
  const { commitSha } = await client.writeFile({
    path,
    content: newSpecFile(id, title, input.body),
    message: input.message?.trim() || `docs(specboard): add spec ${path}`,
    mode: "direct",
  });
  await syncRepository(db, repo);
  return { specId: id, path, commitSha };
}
