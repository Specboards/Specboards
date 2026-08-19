import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  GitWriteConflictError,
  writeBranchName,
  type DeleteFileInput,
  type GitRepoClient,
  type InstallationRepo,
  type SpecFile,
  type SpecFileMeta,
  type WriteFileInput,
  type WriteFileResult,
  type WritePullRequest,
} from "@specboards/git";

import { e2eGithubFixturePath } from "@/lib/e2e";
import type { RepoRecord } from "@/lib/github-sync";

/**
 * In-memory (file-backed) fake of the GitHub repo client for E2E runs. It stands
 * in for `createGitHubRepoClient` when `SPECBOARDS_E2E` is set, so the onboarding
 * flow (scan -> import -> starter spec) runs hermetically with no network and no
 * real GitHub App. Repo contents live in a JSON fixture the Playwright harness
 * seeds; writes (id injection, starter specs) persist back to that file so a
 * later scan in the same or a later request sees them.
 *
 * Fixture shape: `{ "owner/name": { files, branches, pulls }, ... }`, where
 * `files` is the default branch. Branches and pull requests are modelled rather
 * than flattened away, because the difference between "committed" and "proposed"
 * is exactly what the PR write path exists to make: a fake that wrote both to
 * the same place would let a test pass while the board silently published an
 * unreviewed change.
 */
type RepoFiles = Record<string, string>;

interface FakePull {
  number: number;
  /** The head branch, which is how a later edit finds the review to join. */
  branch: string;
  title: string;
  state: "open" | "closed";
}

interface FakeRepo {
  /** Contents of the default branch. */
  files: RepoFiles;
  /** Working branches, each a full snapshot taken when it was cut. */
  branches: Record<string, RepoFiles>;
  pulls: FakePull[];
  /**
   * Every blob ever written, keyed by sha, like a real object store. A merge
   * asks for the version its author loaded, which by then may be on no branch
   * at all, so contents cannot simply be looked up by path.
   */
  blobs?: RepoFiles;
}

type Fixture = Record<string, FakeRepo>;

/** Fill in a repo the fixture knows nothing about yet. */
function emptyRepo(): FakeRepo {
  return { files: {}, branches: {}, pulls: [], blobs: {} };
}

function readFixture(): Fixture {
  try {
    return JSON.parse(readFileSync(e2eGithubFixturePath(), "utf8")) as Fixture;
  } catch {
    // Missing/empty fixture reads as "no repos have any files".
    return {};
  }
}

function writeFixture(data: Fixture): void {
  writeFileSync(e2eGithubFixturePath(), JSON.stringify(data, null, 2));
}

function blobShaOf(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/** Convert a spec glob (supporting `*` and `**`) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${body}$`);
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** A fake `GitRepoClient` bound to one repo, reading/writing the shared fixture. */
export function fakeRepoClient(repo: Pick<RepoRecord, "owner" | "name">): GitRepoClient {
  const key = `${repo.owner}/${repo.name}`;

  return {
    async listSpecFiles(globs: string[]): Promise<SpecFile[]> {
      const files = readFixture()[key]?.files ?? {};
      return Object.entries(files)
        .filter(([path]) => matchesAnyGlob(path, globs))
        .map(([path, raw]) => ({ path, raw, blobSha: blobShaOf(raw) }));
    },

    async listSpecFileMetadata(globs: string[]): Promise<SpecFileMeta[]> {
      // The real client answers this from the repo tree without reading blobs.
      // The fixture holds contents in memory, so `size` is measured here; what
      // matters for parity is that callers get bytes, not characters.
      const files = readFixture()[key]?.files ?? {};
      return Object.entries(files)
        .filter(([path]) => matchesAnyGlob(path, globs))
        .map(([path, raw]) => ({
          path,
          blobSha: blobShaOf(raw),
          size: Buffer.byteLength(raw, "utf8"),
        }));
    },

    async readFile(path: string, ref?: string): Promise<SpecFile> {
      // Defaults to the default branch, like the real client reading at its
      // configured ref: a change waiting in a pull request is deliberately not
      // visible until asked for by branch.
      const repo = readFixture()[key];
      const files = ref ? repo?.branches[ref] : repo?.files;
      const raw = files?.[path];
      if (raw === undefined) {
        throw new Error(
          `E2E fake: ${key}${ref ? `@${ref}` : ""} has no file at ${path}`,
        );
      }
      return { path, raw, blobSha: blobShaOf(raw) };
    },

    async readBlobBySha(sha: string): Promise<string> {
      const raw = readFixture()[key]?.blobs?.[sha];
      if (raw === undefined) {
        throw new Error(`E2E fake: ${key} has no blob ${sha}`);
      }
      return raw;
    },

    async writeFile(input: WriteFileInput): Promise<WriteFileResult> {
      const data = readFixture();
      const repo = (data[key] ??= emptyRepo());
      const target =
        input.mode === "pr" ? resolveBranch(repo, input.path) : null;
      const files = target ? repo.branches[target]! : repo.files;

      // Mirror the real client's guard: null = must not exist, sha = must match.
      // Checked against the branch being written, which in PR mode is the
      // working branch rather than the default one.
      if (input.expectedBlobSha !== undefined) {
        const existing = files[input.path];
        const conflict =
          input.expectedBlobSha === null
            ? existing !== undefined
            : existing === undefined || blobShaOf(existing) !== input.expectedBlobSha;
        if (conflict) throw new GitWriteConflictError(input.path, target ?? undefined);
      }
      files[input.path] = input.content;
      // Keep every version, not just the reachable ones: a merge asks for the
      // blob its author loaded, which this write may just have replaced.
      (repo.blobs ??= {})[blobShaOf(input.content)] = input.content;

      const pullRequest = target
        ? openOrJoinPull(repo, target, input.message)
        : undefined;
      writeFixture(data);
      return {
        commitSha: blobShaOf(`${target ?? "main"}\n${input.path}\n${input.content}`),
        blobSha: blobShaOf(input.content),
        ...(pullRequest ? { pullRequest } : {}),
      };
    },

    async deleteFile(input: DeleteFileInput): Promise<{ commitSha: string }> {
      const data = readFixture();
      const repo = data[key] ?? emptyRepo();
      const existing = repo.files[input.path];
      if (
        existing === undefined ||
        (input.expectedBlobSha !== undefined && blobShaOf(existing) !== input.expectedBlobSha)
      ) {
        throw new GitWriteConflictError(input.path);
      }
      delete repo.files[input.path];
      writeFixture(data);
      return { commitSha: blobShaOf(`delete ${input.path}\n${existing}`) };
    },
  };
}

/**
 * The working branch a PR-mode write to `path` belongs on, cutting a new one
 * from the default branch when there is no review already open for the file.
 * Mirrors the real client's rule, not its exact naming: only an *open* pull
 * request's branch is joined, so a branch left behind by a closed one is never
 * written to again. The disambiguating suffix differs (a counter here, the base
 * sha there) because the fake has no commit graph to take a sha from.
 */
function resolveBranch(repo: FakeRepo, path: string): string {
  const stem = writeBranchName(path);
  const open = repo.pulls.find((p) => p.state === "open" && p.branch === stem);
  if (open) return stem;

  let branch = stem;
  for (let n = 2; repo.branches[branch] !== undefined; n++) branch = `${stem}-${n}`;
  repo.branches[branch] = { ...repo.files };
  return branch;
}

/** The open pull request for `branch`, opening one if there is none. */
function openOrJoinPull(
  repo: FakeRepo,
  branch: string,
  title: string,
): WritePullRequest {
  const existing = repo.pulls.find((p) => p.state === "open" && p.branch === branch);
  if (existing) {
    return { number: existing.number, url: pullUrl(existing.number), branch, created: false };
  }
  const number = repo.pulls.length + 1;
  repo.pulls.push({ number, branch, title, state: "open" });
  return { number, url: pullUrl(number), branch, created: true };
}

function pullUrl(number: number): string {
  return `https://github.test/pull/${number}`;
}

/**
 * The repos the fixture holds for one account, shaped like GitHub's
 * installation-repo listing. Lets the connect pickers work in E2E: a repo
 * seeded as `"acme/handbook"` shows up as connectable for the `acme`
 * installation.
 */
export function e2eInstallationRepos(accountLogin: string): InstallationRepo[] {
  const prefix = `${accountLogin}/`;
  return Object.keys(readFixture())
    .filter((key) => key.startsWith(prefix))
    .map((key) => ({
      owner: accountLogin,
      name: key.slice(prefix.length),
      defaultBranch: "main",
      private: true,
    }));
}
