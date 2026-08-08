import { randomUUID } from "node:crypto";
import { type ParsedSpec, hasSpecId, parseSpec } from "@specboards/core";

/** A spec file discovered in a repo, with its git pointers. */
export interface SpecFile {
  path: string;
  blobSha: string;
  raw: string;
}

/**
 * Minimal surface the git layer needs from a host (GitHub App, local clone,
 * or a fake in tests). Concrete GitHub implementation lives in `github.ts`.
 */
export interface GitRepoClient {
  /** List spec files matching the repo's configured globs. */
  listSpecFiles(globs: string[]): Promise<SpecFile[]>;
  /**
   * Read a single file's contents + sha, at the client's ref by default.
   * `ref` names a different branch, which is how a conflict on a working
   * branch reports the version that actually beat the caller: the default
   * branch's copy would be a different file entirely.
   */
  readFile(path: string, ref?: string): Promise<SpecFile>;
  /**
   * Read a blob's contents by sha, regardless of which branch still points at
   * it. This is how a three-way merge gets its base: the version the author
   * loaded may have been replaced on every branch by the time they save, so it
   * is reachable only by the sha they were handed.
   */
  readBlobBySha(sha: string): Promise<string>;
  /** Write a file back, returning the new commit sha and the new blob sha. */
  writeFile(input: WriteFileInput): Promise<WriteFileResult>;
  /** Delete a file with a commit, returning the commit sha. */
  deleteFile(input: DeleteFileInput): Promise<{ commitSha: string }>;
}

/** The pull request a `mode: "pr"` write proposed the change through. */
export interface WritePullRequest {
  number: number;
  url: string;
  /** The head branch the commit landed on. */
  branch: string;
  /**
   * False when the commit joined a pull request that was already open for this
   * file. Callers use it to tell an author their change was added to the review
   * already in flight rather than starting a second one.
   */
  created: boolean;
}

export interface WriteFileResult {
  commitSha: string;
  blobSha: string;
  /**
   * Set only for a `mode: "pr"` write. Its absence is what tells a caller the
   * change is already on the default branch: in PR mode nothing the board reads
   * has changed yet, so re-syncing or reporting "saved" would both be wrong.
   */
  pullRequest?: WritePullRequest;
}

export interface WriteFileInput {
  path: string;
  content: string;
  message: string;
  /** "direct" commits to the branch; "pr" opens a PR from a new branch. */
  mode: "direct" | "pr";
  /**
   * Concurrent-edit guard. A blob sha means "update: the file must still be
   * at this sha"; null means "create: the file must not exist yet". Omitted
   * (undefined) keeps the unguarded last-write-wins behavior spec sync uses.
   * A failed guard rejects with {@link GitWriteConflictError}.
   */
  expectedBlobSha?: string | null;
}

export interface DeleteFileInput {
  path: string;
  message: string;
  /** When set, the file must still be at this blob sha (see WriteFileInput). */
  expectedBlobSha?: string;
}

/**
 * A guarded write or delete lost the race: the file changed (or appeared, or
 * disappeared) on the remote since the caller loaded it.
 */
export class GitWriteConflictError extends Error {
  constructor(
    readonly path: string,
    /**
     * The branch the write was aimed at, when it is known. Callers that want to
     * show the author what beat them need this rather than the default branch:
     * a PR-mode write lands on a working branch, and the losing version lives
     * there, not on the base.
     */
    readonly ref?: string,
  ) {
    super(`${path} changed on the remote since it was loaded.`);
    this.name = "GitWriteConflictError";
  }
}

/** Outcome of importing/reconciling one spec. */
export interface ReconciledSpec {
  path: string;
  blobSha: string;
  spec: ParsedSpec;
  /** True when an `id` had to be injected (and committed) on first import. */
  idInjected: boolean;
}

/**
 * Import or reconcile specs from a repo: parse each file, inject a stable `id`
 * into any spec that lacks one (writing it back to git), and return structured
 * specs the caller can upsert into `features` + `spec_index`.
 *
 * NOTE: scaffold. The GitHub-backed `GitRepoClient` and webhook signature
 * verification are stubbed in `github.ts` / `webhook.ts` and need wiring.
 */
export async function reconcileSpecs(
  client: GitRepoClient,
  globs: string[],
): Promise<ReconciledSpec[]> {
  const files = await client.listSpecFiles(globs);
  const out: ReconciledSpec[] = [];

  for (const file of files) {
    let { raw, blobSha } = file;
    let idInjected = false;

    if (!hasSpecId(raw)) {
      raw = injectSpecId(raw, randomUUID());
      const written = await client.writeFile({
        path: file.path,
        content: raw,
        message: `chore(specboards): assign stable id to ${file.path}`,
        mode: "direct",
      });
      // Track the new blob sha so a later tree walk sees this file as unchanged.
      blobSha = written.blobSha;
      idInjected = true;
    }

    // A spec's frontmatter comes from a connected repo (any contributor with
    // push access), so a single malformed file must not abort the whole sync.
    // Skip the bad file and reconcile the rest; the parse error is logged.
    let spec: ParsedSpec;
    try {
      spec = parseSpec(raw, file.path);
    } catch (err) {
      console.warn(
        `[specboards] skipping unparseable spec ${file.path}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    out.push({ path: file.path, blobSha, spec, idInjected });
  }

  return out;
}

/** Insert an `id:` line into existing YAML frontmatter (or create a block). */
export function injectSpecId(raw: string, id: string): string {
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const head = raw.slice(0, end);
      const rest = raw.slice(end);
      return `${head}\nid: ${id}${rest}`;
    }
  }
  return `---\nid: ${id}\n---\n\n${raw}`;
}

export * from "./github.js";
export * from "./user-oauth.js";
export * from "./webhook.js";
