import { App, type Octokit } from "octokit";

import { compileGlobs } from "./webhook.js";
import type { GitRepoClient, SpecFile, WriteFileInput } from "./index.js";

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
  return new App({ appId, privateKey: privateKey.replace(/\\n/g, "\n") });
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
        body: `Automated by SpecBoard.\n\n${input.message}`,
      });
    }

    return result;
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

  /** Commit a single file to `branch`, creating or updating it. */
  private async commitFile(
    input: WriteFileInput,
    branch: string,
  ): Promise<{ commitSha: string; blobSha: string }> {
    const sha = await this.currentBlobSha(input.path, branch);
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
