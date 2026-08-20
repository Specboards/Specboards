// Octokit is a value here, not just a type: the user-token client constructs
// one directly rather than getting it from the App's installation cache.
import { App, Octokit } from "octokit";

import { compileGlobs } from "./webhook.js";
import {
  GitWriteConflictError,
  type DeleteFileInput,
  type GitRepoClient,
  type SpecFile,
  type SpecFileMeta,
  type WriteFileInput,
  type WriteFileResult,
  type WritePullRequest,
} from "./index.js";

/**
 * How many blobs `listSpecFiles` reads at once.
 *
 * Chosen to keep a large repo's sync brisk without opening a connection per
 * file. GitHub's REST limit is 5000 requests/hour for an App installation, so
 * the cost that matters is not the ceiling but the burst: an unbounded fan-out
 * over a few thousand specs spends a meaningful slice of the hour instantly and
 * competes with every other call the installation is making.
 */
const BLOB_READ_CONCURRENCY = 8;

/**
 * Ceilings on what one scan or sync of a repository may pull in.
 *
 * Neither existed. `matchingBlobs` returned every match in the tree and
 * `listSpecFiles` then read all of them, so the work a single connected
 * repository could cause was bounded only by that repository. A repo with fifty
 * thousand matching Markdown files, whether by accident or by someone connecting
 * one on purpose, meant fifty thousand blob reads, the whole content resident,
 * and the installation's GitHub rate limit spent in one call.
 *
 * These are limits on OUR appetite, not a judgement about the customer's repo:
 * both are far above any real spec tree (the largest in-house repo has tens),
 * and both are reported loudly rather than silently truncating, so an operator
 * whose repository is genuinely this large finds out instead of quietly losing
 * files. That is the same posture the existing `data.truncated` warning takes.
 */
const MAX_MATCHING_FILES = 5_000;
const MAX_TOTAL_BLOB_BYTES = 50 * 1024 * 1024; // 50 MB

/** Raised when a repository is too large to scan in one pass. */
export class RepoTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoTooLargeError";
  }
}

/**
 * `items.map(fn)` with at most `limit` in flight, preserving input order.
 *
 * Workers pull from a shared cursor rather than being handed a fixed slice, so
 * one slow blob does not idle the others.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/** Cached-display metadata for a linked GitHub artifact (PR/issue/branch). */
export interface GithubArtifactMeta {
  title: string | null;
  /** open / closed / merged for PRs/issues; null for a branch. */
  state: string | null;
  url: string;
}

/** Identifies a single connected repository at a given ref. */
export interface GitHubRepoConfig {
  installationId: string;
  owner: string;
  name: string;
  /** Branch (or tag/sha) specs are read from and written to. */
  ref: string;
}

/** GitHub App credentials, typically sourced from env. */
export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

/**
 * Build a GitHub App from the standard env vars, or return `null` when they
 * are unset (local/self-host without the App configured). `GITHUB_APP_ID` is
 * the numeric App id; `GITHUB_APP_PRIVATE_KEY` is the PEM (literal `\n` escapes
 * are unfolded so it can live on a single secret line).
 */
export function githubAppFromEnv(): App | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  return githubAppFrom({ appId, privateKey });
}

/**
 * Build a GitHub App from explicit credentials (e.g. loaded from the DB after
 * the in-app manifest setup). Literal `\n` escapes in the PEM are unfolded.
 */
export function githubAppFrom(credentials: GitHubAppCredentials): App {
  return new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey.replace(/\\n/g, "\n"),
  });
}

/** A repository an installation can access, for the connect picker. */
export interface InstallationRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

/**
 * List every repository the given installation has been granted access to —
 * i.e. the repos the user selected when installing the App. Powers the
 * "select a repository" picker so no one has to copy ids by hand.
 */
export async function listInstallationRepositories(
  app: App,
  installationId: string,
): Promise<InstallationRepo[]> {
  const octokit = await app.getInstallationOctokit(Number(installationId));
  const repos = await octokit.paginate(
    octokit.rest.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  );
  return repos.map((repo) => ({
    owner: repo.owner.login,
    name: repo.name,
    defaultBranch: repo.default_branch,
    private: repo.private,
  }));
}

/** The account (organization or user) an App installation is installed on. */
export interface InstallationAccount {
  login: string;
  /** "Organization" or "User" (GitHub may add other kinds, e.g. enterprises). */
  type: string;
}

/**
 * Look up who an installation is installed on. Repo creation is only possible
 * for organization installations (GitHub has no installation-token endpoint
 * that creates repos under a personal account), so callers branch on `type`.
 */
export async function getInstallationAccount(
  app: App,
  installationId: string,
): Promise<InstallationAccount> {
  const { data } = await app.octokit.rest.apps.getInstallation({
    installation_id: Number(installationId),
  });
  const account = data.account;
  if (!account || !("login" in account) || typeof account.login !== "string") {
    throw new Error("Couldn't resolve the installation's account.");
  }
  return {
    login: account.login,
    type: "type" in account && typeof account.type === "string" ? account.type : "unknown",
  };
}

/** A repository created for an installation, plus its GitHub URL. */
export interface CreatedRepo extends InstallationRepo {
  htmlUrl: string;
}

/**
 * Create a private repository in the installation's organization, initialized
 * with a README so the default branch exists for the first spec commit. Needs
 * the App's repository Administration (write) permission; GitHub automatically
 * grants the installation access to a repo the App itself creates.
 */
export async function createInstallationOrgRepository(
  app: App,
  installationId: string,
  input: { org: string; name: string; description?: string },
): Promise<CreatedRepo> {
  const octokit = await app.getInstallationOctokit(Number(installationId));
  const { data } = await octokit.rest.repos.createInOrg({
    org: input.org,
    name: input.name,
    description: input.description,
    private: true,
    auto_init: true,
  });
  return {
    owner: data.owner.login,
    name: data.name,
    defaultBranch: data.default_branch ?? "main",
    private: data.private,
    htmlUrl: data.html_url,
  };
}

/**
 * Resolve an installation-authenticated {@link GitHubRepoClient} for a repo.
 * The `App` mints (and caches) a short-lived installation token under the hood.
 */
export async function createGitHubRepoClient(
  app: App,
  config: GitHubRepoConfig,
): Promise<GitHubRepoClient> {
  const octokit = await app.getInstallationOctokit(Number(config.installationId));
  return new GitHubRepoClient(octokit, config);
}

/**
 * A {@link GitHubRepoClient} authenticated as a *person* rather than as the App
 * installation, so the commits it makes are genuinely theirs: their name, their
 * avatar, and their repository permissions rather than the App's.
 *
 * The token is a GitHub App user-to-server token, so this is not a wider reach
 * than the installation client but a narrower one: it can only touch repos
 * where the App is installed, and only where the user's own access allows it.
 */
export function createGitHubUserRepoClient(
  token: string,
  config: Pick<GitHubRepoConfig, "owner" | "name" | "ref">,
): GitHubRepoClient {
  return new GitHubRepoClient(new Octokit({ auth: token }), config);
}

/**
 * GitHub App-backed {@link GitRepoClient}. Reads specs via the git tree/blob
 * APIs and writes them back either directly (contents API commit) or as a PR.
 * Construct via {@link createGitHubRepoClient} so the installation token is set
 * up; the constructor stays injectable for tests with a fake Octokit.
 */
export class GitHubRepoClient implements GitRepoClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly ref: string;

  constructor(
    private readonly octokit: Octokit,
    config: Pick<GitHubRepoConfig, "owner" | "name" | "ref">,
  ) {
    this.owner = config.owner;
    this.repo = config.name;
    this.ref = config.ref;
  }

  /** Walk the repo tree at `ref` and return the entries matching `globs`. */
  private async matchingBlobs(
    globs: string[],
  ): Promise<{ path: string; sha: string; size?: number }[]> {
    const { data } = await this.octokit.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: this.ref,
      recursive: "true",
    });

    if (data.truncated) {
      // The tree exceeded GitHub's response cap; some specs may be missed.
      console.warn(
        `[git] tree for ${this.owner}/${this.repo}@${this.ref} was truncated; some spec files may be skipped`,
      );
    }

    const matches = compileGlobs(globs);
    const matched = data.tree.filter(
      (entry): entry is typeof entry & { path: string; sha: string } =>
        entry.type === "blob" &&
        typeof entry.path === "string" &&
        typeof entry.sha === "string" &&
        matches(entry.path),
    );

    // Refused rather than truncated. Silently taking the first 5,000 would mean
    // a repository that syncs most of its specs and drops the rest with nothing
    // to say which, which is a worse outcome than a clear failure an operator
    // can act on.
    if (matched.length > MAX_MATCHING_FILES) {
      throw new RepoTooLargeError(
        `${this.owner}/${this.repo}@${this.ref} matches ${matched.length.toLocaleString()} files, ` +
          `above the ${MAX_MATCHING_FILES.toLocaleString()} Specboards will scan in one pass. ` +
          `Narrow the spec globs for this repository, or split it.`,
      );
    }

    const totalBytes = matched.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (totalBytes > MAX_TOTAL_BLOB_BYTES) {
      throw new RepoTooLargeError(
        `${this.owner}/${this.repo}@${this.ref} matches ${(totalBytes / 1024 / 1024).toFixed(1)} MB ` +
          `of files, above the ${MAX_TOTAL_BLOB_BYTES / 1024 / 1024} MB Specboards will read in one ` +
          `pass. Narrow the spec globs for this repository, or split it.`,
      );
    }

    return matched;
  }

  /**
   * List matching files from the tree alone: one API call, no blob reads.
   *
   * `size` comes straight off the tree entry, which is what makes this the
   * right call for a listing. GitHub omits it for entries it cannot size, and
   * 0 is the honest answer there rather than a reason to go and fetch.
   */
  async listSpecFileMetadata(globs: string[]): Promise<SpecFileMeta[]> {
    const blobs = await this.matchingBlobs(globs);
    return blobs.map((entry) => ({
      path: entry.path,
      blobSha: entry.sha,
      size: entry.size ?? 0,
    }));
  }

  /**
   * Walk the repo tree at `ref` and read every blob matching `globs`.
   *
   * Reads are issued at a bounded concurrency. This used to be one
   * `Promise.all` over every match, which on a large repo meant thousands of
   * simultaneous GitHub requests, a rate limit spent in a single call, and every
   * file resident in memory at once. Callers that only need to know which files
   * exist should use {@link listSpecFileMetadata} instead of paying for any of
   * this.
   */
  async listSpecFiles(globs: string[]): Promise<SpecFile[]> {
    const blobs = await this.matchingBlobs(globs);
    return mapWithConcurrency(blobs, BLOB_READ_CONCURRENCY, async (entry) => ({
      path: entry.path,
      blobSha: entry.sha,
      raw: await this.readBlob(entry.sha),
    }));
  }

  /** Read a single file's content + blob sha at `ref` via the contents API. */
  async readFile(path: string, ref = this.ref): Promise<SpecFile> {
    const { data } = await this.octokit.rest.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path,
      ref,
    });
    if (Array.isArray(data) || data.type !== "file") {
      throw new Error(`Expected a file at ${path}, got a ${Array.isArray(data) ? "directory" : data.type}`);
    }
    return {
      path,
      blobSha: data.sha,
      raw: Buffer.from(data.content, "base64").toString("utf8"),
    };
  }

  /**
   * Write `content` to `path`. "direct" commits straight onto `ref`; "pr"
   * commits to a working branch for this file and proposes it, joining the pull
   * request already open for that file rather than opening a second one.
   * Returns the new commit sha, the new blob sha (what `spec_index.blobSha`
   * tracks for drift detection), and in PR mode the pull request.
   */
  async writeFile(input: WriteFileInput): Promise<WriteFileResult> {
    if (input.mode !== "pr") return this.commitFile(input, this.ref);

    const open = await this.openSpecboardsPull(input.path);
    const branch = open?.branch ?? (await this.createWriteBranch(input.path));
    const result = await this.commitFile(input, branch);
    const pullRequest = open ?? (await this.openPull(branch, input.message));
    return { ...result, pullRequest };
  }

  /** Fetch a pull request's cached-display metadata (title/state/url). */
  async getPullRequest(number: number): Promise<GithubArtifactMeta> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
    });
    return {
      title: data.title,
      // A merged PR reports state "closed"; surface "merged" explicitly.
      state: data.merged_at ? "merged" : data.state,
      url: data.html_url,
    };
  }

  /**
   * The most recent review comment left on a pull request, or null.
   *
   * A closed pull request carries no reason of its own: GitHub has a close
   * reason for issues but not for these, so the only place a "why" exists is
   * what a reviewer wrote. Telling an author their change was turned down
   * without saying why is barely better than not telling them, so it is worth
   * one extra call on an event that is rare.
   *
   * Reviews with no body (a bare approval, or a change request whose text sits
   * on individual lines) are skipped rather than surfaced as an empty quote.
   */
  async getLatestReviewBody(number: number): Promise<string | null> {
    const { data } = await this.octokit.rest.pulls.listReviews({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      per_page: 100,
    });
    for (let i = data.length - 1; i >= 0; i--) {
      const body = data[i]?.body?.trim();
      if (body) return body;
    }
    return null;
  }

  /** Fetch an issue's metadata. (Note: PRs are issues; pass real issues here.) */
  async getIssue(number: number): Promise<GithubArtifactMeta> {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
    });
    return { title: data.title, state: data.state, url: data.html_url };
  }

  /** Verify a branch exists and return a link to it (branches have no state). */
  async getBranch(name: string): Promise<GithubArtifactMeta> {
    await this.octokit.rest.repos.getBranch({
      owner: this.owner,
      repo: this.repo,
      branch: name,
    });
    return {
      title: name,
      state: null,
      url: `https://github.com/${this.owner}/${this.repo}/tree/${encodeURIComponent(name)}`,
    };
  }

  /** Read a blob by sha (see {@link GitRepoClient.readBlobBySha}). */
  readBlobBySha(sha: string): Promise<string> {
    return this.readBlob(sha);
  }

  private async readBlob(sha: string): Promise<string> {
    const { data } = await this.octokit.rest.git.getBlob({
      owner: this.owner,
      repo: this.repo,
      file_sha: sha,
    });
    // Blob content is base64 (the API also supports "utf-8" but only for small,
    // valid-UTF-8 blobs); base64 is the safe universal path.
    return Buffer.from(data.content, "base64").toString("utf8");
  }

  /**
   * Delete a file from `ref` with one commit. With `expectedBlobSha` the
   * delete is guarded (conflict when the file moved); without it the current
   * sha is looked up, and a file that's already gone is a conflict too.
   */
  async deleteFile(input: DeleteFileInput): Promise<{ commitSha: string }> {
    const sha =
      input.expectedBlobSha ?? (await this.currentBlobSha(input.path, this.ref));
    if (!sha) throw new GitWriteConflictError(input.path);
    try {
      const { data } = await this.octokit.rest.repos.deleteFile({
        owner: this.owner,
        repo: this.repo,
        path: input.path,
        message: input.message,
        sha,
        branch: this.ref,
      });
      return { commitSha: data.commit.sha ?? "" };
    } catch (err) {
      if (isWriteConflict(err) || isNotFound(err)) {
        throw new GitWriteConflictError(input.path);
      }
      throw err;
    }
  }

  /** Commit a single file to `branch`, creating or updating it. */
  private async commitFile(
    input: WriteFileInput,
    branch: string,
  ): Promise<{ commitSha: string; blobSha: string }> {
    // A guarded write trusts the caller's sha (null = "must not exist") and
    // lets GitHub reject a stale one; an unguarded write looks the sha up.
    const sha =
      input.expectedBlobSha !== undefined
        ? (input.expectedBlobSha ?? undefined)
        : await this.currentBlobSha(input.path, branch);
    try {
      const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: input.path,
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      });
      return {
        commitSha: data.commit.sha ?? "",
        blobSha: data.content?.sha ?? "",
      };
    } catch (err) {
      // 409: the provided sha is stale. 422: the file exists but no sha was
      // sent (a guarded create losing to a concurrent create).
      if (input.expectedBlobSha !== undefined && isWriteConflict(err)) {
        throw new GitWriteConflictError(input.path, branch);
      }
      throw err;
    }
  }

  /** Existing blob sha for `path` on `branch`, or undefined if it's new. */
  private async currentBlobSha(path: string, branch: string): Promise<string | undefined> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: branch,
      });
      if (!Array.isArray(data) && data.type === "file") return data.sha;
      return undefined;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /**
   * The pull request already open for `path`, or null.
   *
   * This is what stops a customer who fixes three typos from filing three pull
   * requests. Only an *open* one counts: a branch left behind by a merged or
   * closed pull request must never be revived, or the next edit arrives carrying
   * changes the team already turned down.
   */
  private openSpecboardsPull(path: string): Promise<WritePullRequest | null> {
    return this.pullForBranch(writeBranchName(path));
  }

  /** Open a pull request from `branch` onto `ref`. */
  private async openPull(branch: string, message: string): Promise<WritePullRequest> {
    try {
      const { data } = await this.octokit.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        head: branch,
        base: this.ref,
        title: message,
        body: `Automated by Specboards.\n\n${message}`,
      });
      return { number: data.number, url: data.html_url, branch, created: true };
    } catch (err) {
      // GitHub rejects a second pull request for the same head with a 422. The
      // commit has already landed by this point, so losing that race must not
      // read as a failed save: find the pull request that beat us and report it.
      if (!isAlreadyExists(err)) throw err;
      const existing = await this.pullForBranch(branch);
      if (!existing) throw err;
      return existing;
    }
  }

  /** The open pull request whose head is `branch`, or null. */
  private async pullForBranch(branch: string): Promise<WritePullRequest | null> {
    const { data } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      head: `${this.owner}:${branch}`,
      per_page: 1,
    });
    const pull = data[0];
    return pull
      ? { number: pull.number, url: pull.html_url, branch, created: false }
      : null;
  }

  /**
   * Create a fresh branch off `ref` for a PR write, returning its name.
   *
   * Prefers the stable per-file name, so the next edit finds it by construction.
   * When that name is taken by a branch with no open pull request behind it, the
   * base sha (and, failing that, a counter) disambiguates rather than reusing
   * somebody else's leftovers.
   */
  private async createWriteBranch(path: string): Promise<string> {
    const base = await this.octokit.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.ref}`,
    });
    const baseSha = base.data.object.sha;
    const stem = writeBranchName(path);
    const candidates = [
      stem,
      `${stem}-${baseSha.slice(0, 8)}`,
      ...[2, 3, 4].map((n) => `${stem}-${baseSha.slice(0, 8)}-${n}`),
    ];
    for (const branch of candidates) {
      try {
        await this.octokit.rest.git.createRef({
          owner: this.owner,
          repo: this.repo,
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        });
        return branch;
      } catch (err) {
        // 422 is "reference already exists"; anything else is a real failure.
        if (!isAlreadyExists(err)) throw err;
      }
    }
    throw new Error(
      `Couldn't create a branch for ${path}: ${candidates.length} candidate names are already taken.`,
    );
  }
}

/**
 * The working branch a spec file's proposed changes accumulate on. Derived from
 * the path alone, with no sha or timestamp in it, precisely so a later edit to
 * the same file resolves to the same branch and joins the review in flight.
 */
export function writeBranchName(path: string): string {
  const slug = path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `specboards/${slug}`;
}

/** True for a GitHub 404 (Octokit RequestError shape). */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === 404;
}

/**
 * True for GitHub's 422, which is how both "reference already exists" and "a
 * pull request already exists for this head" come back. Kept apart from
 * {@link isWriteConflict} because there 422 means something else entirely (a
 * guarded create that lost a race), and one helper covering both would make a
 * branch collision and a lost write indistinguishable.
 */
function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "status" in err && err.status === 422
  );
}

/** True for the statuses GitHub uses for contents-API sha conflicts. */
function isWriteConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err.status === 409 || err.status === 422)
  );
}
