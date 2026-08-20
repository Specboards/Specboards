import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two boundaries the GitHub-backed doc tools have to respect (F13).
 *
 * 1. `docs:write` must not reach a spec. That scope is carried by the standard
 *    author grant; `specs:write` is a separate decision, and a spec write goes
 *    down a different road with its own authorization, audit record and review
 *    gate. `validateDocPath` only ever checked "ends in .md, no traversal, no
 *    dotfiles", so `specs/<slug>/spec.md` passed.
 * 2. A doc write must honour the repository's write mode. These helpers
 *    hardcoded `mode: "direct"` while `spec-content.ts` resolves it, so a repo
 *    configured for pull-request review got that on its specs and not on its
 *    docs.
 *
 * Not exploitable today: no deployment points a doc area at a repo that also
 * holds specs. It is fixed now because the moment one does, the default author
 * grant quietly crosses the boundary, and changing the meaning of a grant a
 * customer already relies on is far more expensive than a confinement change
 * against no live data.
 *
 * The repo client is mocked because the assertions are about what we ASK it to
 * do. A real GitHub round trip would test Octokit.
 */

const writeFile = vi.fn(async () => ({ commitSha: "c1", blobSha: "b1" }));
const deleteFile = vi.fn(async () => ({ commitSha: "c2" }));
const readFile = vi.fn(async () => ({ raw: "# Page", blobSha: "b0" }));

const repo = {
  id: "repo-1",
  workspaceId: "ws-1",
  config: null as unknown,
  writeModeOverride: null as string | null,
};

vi.mock("@/lib/github-sync", () => ({
  resolveRepoClient: vi.fn(async () => ({ writeFile, deleteFile, readFile })),
  // The real one, so the guard is checked against the same globs the sync path
  // uses rather than a copy that could drift.
  repoGlobs: (r: { config: unknown }) => {
    const globs = (r.config as { specGlobs?: string[] } | null)?.specGlobs;
    return globs && globs.length > 0 ? globs : ["specs/**/spec.md"];
  },
}));

const space = {
  mode: "github" as const,
  repoId: "repo-1",
  productId: "prod-1",
  area: "architecture" as const,
  externalUrl: null,
};

/**
 * The smallest thing `requireDocRepo` will accept: a Drizzle-shaped chain that
 * ends in this one repository row.
 *
 * Stubbing the query rather than the function, because `requireDocRepo` is
 * called from inside the module under test and an ESM spy on the export does
 * not intercept that. This also means the real `requireDocRepo` runs, which is
 * one less thing assumed.
 */
const db = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => [repo] }),
    }),
  }),
} as never;

describe("doc writes against a repo that also holds specs", () => {
  let docs: typeof import("./github-docs");

  beforeEach(async () => {
    vi.clearAllMocks();
    repo.config = null;
    repo.writeModeOverride = null;
    docs = await import("./github-docs");
  });

  it("refuses to save over a spec path", async () => {
    await expect(
      docs.saveGithubDocFile(db, "ws-1", space, "specs/billing/spec.md", "hi", null),
    ).rejects.toThrow(/spec file in this repository/i);
    // Nothing reached GitHub: the refusal is before the client is asked.
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refuses to delete a spec path", async () => {
    await expect(
      docs.deleteGithubDocFile(db, "ws-1", space, "specs/billing/spec.md", "b0"),
    ).rejects.toThrow(/spec file in this repository/i);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("refuses a rename at either end", async () => {
    // Reading a spec out through a rename, and writing one in by choosing the
    // destination, are both the same boundary.
    await expect(
      docs.renameGithubDocFile(db, "ws-1", space, "specs/a/spec.md", "docs/a.md"),
    ).rejects.toThrow(/spec file in this repository/i);
    await expect(
      docs.renameGithubDocFile(db, "ws-1", space, "docs/a.md", "specs/a/spec.md"),
    ).rejects.toThrow(/spec file in this repository/i);
    expect(writeFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("follows the repository's own spec globs, not a hardcoded prefix", async () => {
    // A customer who configured their specs elsewhere gets the same protection,
    // and a path that merely looks spec-ish under the default config does not.
    repo.config = { specGlobs: ["product/**/definition.md"] };
    await expect(
      docs.saveGithubDocFile(db, "ws-1", space, "product/x/definition.md", "hi", null),
    ).rejects.toThrow(/spec file in this repository/i);

    await expect(
      docs.saveGithubDocFile(db, "ws-1", space, "specs/billing/spec.md", "hi", null),
    ).resolves.toBeDefined();
  });

  it("still allows an ordinary doc page", async () => {
    await expect(
      docs.saveGithubDocFile(db, "ws-1", space, "docs/getting-started.md", "hi", null),
    ).resolves.toMatchObject({ blobSha: "b1" });
    expect(writeFile).toHaveBeenCalledOnce();
  });
});

describe("which write mode a doc edit uses", () => {
  let docs: typeof import("./github-docs");

  beforeEach(async () => {
    vi.clearAllMocks();
    repo.config = null;
    repo.writeModeOverride = null;
    docs = await import("./github-docs");
  });

  it("opens a pull request when the repository is review-gated", async () => {
    // The finding: these helpers hardcoded "direct", so a repo whose owner
    // chose review got it on specs and not on docs, and a doc edit went
    // straight to the default branch.
    repo.config = { writeMode: "pr" };
    await docs.saveGithubDocFile(db, "ws-1", space, "docs/a.md", "hi", null);
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ mode: "pr" }));
  });

  it("honours a per-repository override above the config", async () => {
    repo.config = { writeMode: "pr" };
    repo.writeModeOverride = "direct";
    await docs.saveGithubDocFile(db, "ws-1", space, "docs/a.md", "hi", null);
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ mode: "direct" }));
  });

  it("commits directly when that is what the repository says", async () => {
    repo.config = { writeMode: "direct" };
    await docs.saveGithubDocFile(db, "ws-1", space, "docs/a.md", "hi", null);
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ mode: "direct" }));
  });

  it("commits directly when the repository has said nothing", async () => {
    // The schema default is "pr", which is right for a SPEC repo. A docs repo
    // is created with no config at all, so applying that default would make
    // every existing docs repo start proposing pull requests for edits made in
    // a WYSIWYG editor, with the page still showing the old text after Save.
    // The e2e suite caught exactly that when this first honoured the default.
    //
    // An explicit setting is respected; its absence keeps what docs editing has
    // always done. Changing the default for docs is a product decision, not
    // part of a confinement fix.
    repo.config = null;
    repo.writeModeOverride = null;
    await docs.saveGithubDocFile(db, "ws-1", space, "docs/a.md", "hi", null);
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ mode: "direct" }));
  });

  it("honours an override even when the config says nothing", async () => {
    repo.config = null;
    repo.writeModeOverride = "pr";
    await docs.saveGithubDocFile(db, "ws-1", space, "docs/a.md", "hi", null);
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ mode: "pr" }));
  });

  it("uses the resolved mode on a rename too", async () => {
    repo.config = { writeMode: "pr" };
    await docs.renameGithubDocFile(db, "ws-1", space, "docs/a.md", "docs/b.md");
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ mode: "pr" }));
  });
});
