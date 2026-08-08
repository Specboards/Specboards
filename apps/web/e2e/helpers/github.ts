import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Seed the fixture file that the app's fake GitHub client reads (see
 * apps/web/src/lib/github-e2e.ts). Tests set a repo's spec files here, then the
 * server's scan/import sees them. Same file path on both sides via
 * SPECBOARDS_E2E_GITHUB_FIXTURE.
 */
type RepoFiles = Record<string, string>;

interface FakePull {
  number: number;
  branch: string;
  title: string;
  state: "open" | "closed";
}

interface FakeRepo {
  files: RepoFiles;
  branches: Record<string, RepoFiles>;
  pulls: FakePull[];
  /** Every version ever written, by sha; the merge base is fetched from here. */
  blobs?: RepoFiles;
}

type Fixture = Record<string, FakeRepo>;

function fixturePath(): string {
  const path = process.env.SPECBOARDS_E2E_GITHUB_FIXTURE;
  if (!path) throw new Error("SPECBOARDS_E2E_GITHUB_FIXTURE must be set for E2E runs.");
  return path;
}

function read(): Fixture {
  try {
    return JSON.parse(readFileSync(fixturePath(), "utf8")) as Fixture;
  } catch {
    return {};
  }
}

function write(data: Fixture): void {
  mkdirSync(dirname(fixturePath()), { recursive: true });
  writeFileSync(fixturePath(), JSON.stringify(data, null, 2));
}

/** Reset all fake repo contents (call before each test for isolation). */
export function resetFixture(): void {
  write({});
}

/**
 * Set the files (path -> raw content) on one repo's default branch.
 *
 * Called twice in a test this stands in for someone else committing while a
 * page sits open, so it replaces the branch contents but *keeps* everything a
 * real repo would keep: open branches, their pull requests, and every blob ever
 * written. Forgetting old blobs in particular would make a three-way merge
 * unable to fetch the version the author loaded, and the test would then be
 * asserting against a repo that has no equivalent in reality.
 */
export function setRepoFiles(owner: string, name: string, files: RepoFiles): void {
  const data = read();
  const key = `${owner}/${name}`;
  const existing = data[key];
  const blobs: RepoFiles = { ...existing?.blobs };
  for (const raw of Object.values(files)) blobs[blobShaOf(raw)] = raw;
  data[key] = {
    files,
    branches: existing?.branches ?? {},
    pulls: existing?.pulls ?? [],
    blobs,
  };
  write(data);
}

/** Same content-addressing the app's fake uses, so shas agree across the seam. */
function blobShaOf(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/** Read back a repo's default-branch files (e.g. to assert what was committed). */
export function getRepoFiles(owner: string, name: string): RepoFiles {
  return read()[`${owner}/${name}`]?.files ?? {};
}

/**
 * Read back a working branch's files. The distinction from
 * {@link getRepoFiles} is the assertion the PR write path lives or dies on: a
 * proposed change must be on the branch and *not* on the default branch.
 */
export function getRepoBranchFiles(
  owner: string,
  name: string,
  branch: string,
): RepoFiles {
  return read()[`${owner}/${name}`]?.branches[branch] ?? {};
}

/** The pull requests the fake has opened for a repo, in the order opened. */
export function getRepoPulls(owner: string, name: string): FakePull[] {
  return read()[`${owner}/${name}`]?.pulls ?? [];
}

/** Close a pull request, as a reviewer turning the change down would. */
export function closeRepoPull(owner: string, name: string, number: number): void {
  const data = read();
  const pull = data[`${owner}/${name}`]?.pulls.find((p) => p.number === number);
  if (!pull) throw new Error(`No pull request #${number} in ${owner}/${name}.`);
  pull.state = "closed";
  write(data);
}

/** A minimal spec.md body with a stable id (so import skips id injection). */
export function specMd(title: string, id: string): string {
  return `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\nkind: feature\n---\n\n# ${title}\n\nBody.\n`;
}
