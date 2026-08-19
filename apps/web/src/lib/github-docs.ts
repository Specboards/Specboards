import { and, eq, repositories, type Database } from "@specboards/db";

import { resolveRepoClient, type RepoRecord } from "@/lib/github-sync";
import { DocError, type DocSpace } from "@/lib/store/types";

/**
 * GitHub-backed doc spaces (doc_spaces mode `github`): list a docs repo's
 * Markdown files and commit edits back on save. The repo is a `repositories`
 * row created with `isSpecRepo: false` and no config, which keeps it inert to
 * spec sync (the default spec globs never match docs paths, so pushes and
 * scans do no spec work).
 */

/** Every Markdown file in the repo; the UI derives folders from the paths. */
const DOC_GLOBS = ["**/*.md"];

export interface GithubDocFile {
  path: string;
  /** Raw Markdown at the default branch. */
  content: string;
  /** Blob sha at load time; saves send it back as the concurrent-edit guard. */
  blobSha: string;
}

/** One doc page as the repo tree describes it, without its Markdown. */
export interface GithubDocEntry {
  path: string;
  blobSha: string;
  /** Blob size in bytes, off the tree entry rather than the file's length. */
  size: number;
}

/**
 * How many pages a single listing returns.
 *
 * A docs repo is normally tens of files, so this is not a limit anyone should
 * meet; it exists so that a repo which is not normal cannot return an answer
 * large enough to exhaust an agent's context in one call. Callers are told when
 * it bites (see `truncated`) rather than being handed a silent prefix.
 */
const DOC_LIST_LIMIT = 500;

export interface GithubDocRepo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  htmlUrl: string;
}

/** The doc space's backing repositories row, or a DocError when unbound/gone. */
export async function requireDocRepo(
  db: Database,
  workspaceId: string,
  space: DocSpace,
): Promise<RepoRecord> {
  if (space.mode !== "github" || !space.repoId) {
    throw new DocError("This area is not backed by a GitHub repository.");
  }
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.id, space.repoId), eq(repositories.workspaceId, workspaceId)),
    )
    .limit(1);
  if (!repo) {
    throw new DocError("The docs repository is no longer connected.");
  }
  return repo;
}

/**
 * Load the docs repo and list its Markdown files WITHOUT their contents.
 *
 * This is what a listing needs. `loadGithubDocs` reads every blob, which is one
 * GitHub request per file; the only thing `list_docs` ever did with that
 * content was measure its length, so it was downloading an entire documentation
 * tree to report its size. The tree already carries both the sha and the size,
 * so this is a single request whatever the repo contains.
 *
 * Returns at most {@link DOC_LIST_LIMIT} pages, and says so when it truncates:
 * a caller handed a silent prefix would reasonably conclude the rest does not
 * exist.
 */
export async function loadGithubDocIndex(
  db: Database,
  workspaceId: string,
  space: DocSpace,
): Promise<{
  repo: GithubDocRepo;
  entries: GithubDocEntry[];
  truncated: boolean;
  total: number;
}> {
  const repo = await requireDocRepo(db, workspaceId, space);
  const client = await resolveRepoClient(db, repo);
  const meta = await client.listSpecFileMetadata(DOC_GLOBS);
  const sorted = meta
    .map((f) => ({ path: f.path, blobSha: f.blobSha, size: f.size }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    repo: {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      htmlUrl: `https://github.com/${repo.owner}/${repo.name}`,
    },
    entries: sorted.slice(0, DOC_LIST_LIMIT),
    truncated: sorted.length > DOC_LIST_LIMIT,
    total: sorted.length,
  };
}

/**
 * Load the docs repo and all of its Markdown files (content included).
 *
 * Every blob is read, so this is one GitHub request per file (bounded in
 * concurrency by the client, but still linear in file count). Use
 * {@link loadGithubDocIndex} unless the contents are genuinely going to be
 * shown; the editing UI is the case that needs them.
 */
export async function loadGithubDocs(
  db: Database,
  workspaceId: string,
  space: DocSpace,
): Promise<{ repo: GithubDocRepo; files: GithubDocFile[] }> {
  const repo = await requireDocRepo(db, workspaceId, space);
  const client = await resolveRepoClient(db, repo);
  const specFiles = await client.listSpecFiles(DOC_GLOBS);
  const files = specFiles
    .map((f) => ({ path: f.path, content: f.raw, blobSha: f.blobSha }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    repo: {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      htmlUrl: `https://github.com/${repo.owner}/${repo.name}`,
    },
    files,
  };
}

/**
 * Validate a repo-relative Markdown path from the client. Rejects traversal,
 * dotfile segments (protects .specboards/ and .github/), and non-.md targets;
 * the commit surface stays "Markdown docs" only.
 */
export function validateDocPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new DocError("A file path is required.");
  }
  const path = raw.trim();
  if (path.length > 200) throw new DocError("That path is too long.");
  if (!path.toLowerCase().endsWith(".md")) {
    throw new DocError("Docs are Markdown files (.md).");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(segment) || segment === "..") {
      throw new DocError("That path contains unsupported characters.");
    }
  }
  return path;
}

/**
 * Read ONE Markdown file from the docs repo. `loadGithubDocs` fetches every
 * file for the editor's tree; an agent editing a single page needs only that
 * page plus its current sha (the guard `saveGithubDocFile` wants back), so
 * this stays a single blob read rather than a whole-repo listing.
 */
export async function readGithubDocFile(
  db: Database,
  workspaceId: string,
  space: DocSpace,
  path: string,
): Promise<GithubDocFile> {
  const repo = await requireDocRepo(db, workspaceId, space);
  const client = await resolveRepoClient(db, repo);
  try {
    const file = await client.readFile(path);
    return { path, content: file.raw, blobSha: file.blobSha };
  } catch {
    throw new DocError(`No page at "${path}" in the docs repository.`);
  }
}

/**
 * Commit one Markdown file to the docs repo's default branch. `expectedBlobSha`
 * is the concurrent-edit guard: the sha the editor loaded (update), or null for
 * a new page (create). Rejects with GitWriteConflictError when the file moved.
 */
export async function saveGithubDocFile(
  db: Database,
  workspaceId: string,
  space: DocSpace,
  path: string,
  content: string,
  expectedBlobSha: string | null,
): Promise<{ commitSha: string; blobSha: string }> {
  const repo = await requireDocRepo(db, workspaceId, space);
  const client = await resolveRepoClient(db, repo);
  return client.writeFile({
    path,
    content,
    message: `docs: update ${path}`,
    mode: "direct",
    expectedBlobSha,
  });
}

/** Delete one Markdown file from the docs repo (guarded by its loaded sha). */
export async function deleteGithubDocFile(
  db: Database,
  workspaceId: string,
  space: DocSpace,
  path: string,
  expectedBlobSha: string,
): Promise<{ commitSha: string }> {
  const repo = await requireDocRepo(db, workspaceId, space);
  const client = await resolveRepoClient(db, repo);
  return client.deleteFile({
    path,
    message: `docs: delete ${path}`,
    expectedBlobSha,
  });
}

/**
 * Rename (or move) a doc file: commit the current content at the new path,
 * then delete the old one. Two commits; the write is create-guarded so an
 * existing file at the target is never clobbered, and the delete is guarded
 * by the sha that was just read.
 */
export async function renameGithubDocFile(
  db: Database,
  workspaceId: string,
  space: DocSpace,
  fromPath: string,
  toPath: string,
): Promise<{ blobSha: string; content: string }> {
  const repo = await requireDocRepo(db, workspaceId, space);
  const client = await resolveRepoClient(db, repo);
  let current;
  try {
    current = await client.readFile(fromPath);
  } catch {
    throw new DocError("That page no longer exists in the repository.");
  }
  const { blobSha } = await client.writeFile({
    path: toPath,
    content: current.raw,
    message: `docs: rename ${fromPath} to ${toPath}`,
    mode: "direct",
    expectedBlobSha: null,
  });
  await client.deleteFile({
    path: fromPath,
    message: `docs: rename ${fromPath} to ${toPath}`,
    expectedBlobSha: current.blobSha,
  });
  return { blobSha, content: current.raw };
}
