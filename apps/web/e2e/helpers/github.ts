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

/** Set the files (path -> raw content) on one repo's default branch. */
export function setRepoFiles(owner: string, name: string, files: RepoFiles): void {
  const data = read();
  data[`${owner}/${name}`] = { files, branches: {}, pulls: [] };
  write(data);
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
