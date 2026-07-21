import { App, type Octokit } from "octokit";

import { compileGlobs } from "./webhook.js";
import {
  GitWriteConflictError,
  type DeleteFileInput,
  type GitRepoClient,
  type SpecFile,
  type WriteFileInput,
} from "./index.js";

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

  /** Walk the repo tree at `ref` and read every blob matching `globs`. */
  async listSpecFiles(globs: string[]): Promise<SpecFile[]> {
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
    const blobs = data.tree.filter(
      (entry): entry is typeof entry & { path: string; sha: string } =>
        entry.type === "blob" &&
        typeof entry.path === "string" &&
        typeof entry.sha === "string" &&
        matches(entry.path),
    );

    return Promise.all(
      blobs.map(async (entry) => ({
        path: entry.path,
        blobSha: entry.sha,
        raw: await this.readBlob(entry.sha),
      })),
    );
  }

  /** Read a single file's content + blob sha at `ref` via the contents API. */
  async readFile(path: string): Promise<SpecFile> {
    const { data } = await this.octokit.rest.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path,
      ref: this.ref,
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
   * branches off `ref`, commits there, and opens a PR. Returns the new commit
   * sha and the new blob sha (the latter is what `spec_index.blobSha` tracks
   * for drift detection).
   */
  async writeFile(input: WriteFileInput): Promise<{ commitSha: string; blobSha: string }> {
    const branch = input.mode === "pr" ? await this.createWriteBranch(input.path) : this.ref;
    const result = await this.commitFile(input, branch);

    if (input.mode === "pr") {
      await this.octokit.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        head: branch,
        base: this.ref,
        title: input.message,
        body: `Automated by Specboards.\n\n${input.message}`,
      });
    }

    return result;
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
        throw new GitWriteConflictError(input.path);
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

  /** Create a fresh branch off `ref` for a PR write, returning its name. */
  private async createWriteBranch(path: string): Promise<string> {
    const base = await this.octokit.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.ref}`,
    });
    const baseSha = base.data.object.sha;
    const slug = path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const branch = `specboard/${slug}-${baseSha.slice(0, 8)}`;
    await this.octokit.rest.git.createRef({
      owner: this.owner,
      repo: this.repo,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
    return branch;
  }
}

/** True for a GitHub 404 (Octokit RequestError shape). */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === 404;
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
