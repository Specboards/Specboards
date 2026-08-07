import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GitHubRepoClient,
  GitWriteConflictError,
  reconcileSpecs,
  injectSpecId,
  type GitRepoClient,
  type SpecFile,
  type WriteFileInput,
} from "./index.js";
import {
  affectedSpecs,
  matchesAnyGlob,
  parseIssuesEvent,
  parsePullRequestEvent,
  parsePushEvent,
  verifyWebhookSignature,
} from "./webhook.js";

const SECRET = "s3cr3t-webhook-key";

function sign(payload: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  const payload = JSON.stringify({ hello: "world" });

  it("accepts a signature computed with the same secret", () => {
    expect(verifyWebhookSignature(payload, sign(payload), SECRET)).toBe(true);
  });

  it("rejects a signature from the wrong secret", () => {
    expect(verifyWebhookSignature(payload, sign(payload, "other"), SECRET)).toBe(false);
  });

  it("rejects when the payload was tampered with", () => {
    expect(verifyWebhookSignature(payload + " ", sign(payload), SECRET)).toBe(false);
  });

  it("rejects empty / malformed signatures without throwing", () => {
    expect(verifyWebhookSignature(payload, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(payload, "sha256=zz", SECRET)).toBe(false);
    expect(verifyWebhookSignature(payload, sign(payload), "")).toBe(false);
  });
});

describe("glob matching", () => {
  const globs = ["specs/**/spec.md"];

  it("matches nested spec files and rejects others", () => {
    expect(matchesAnyGlob("specs/auth/spec.md", globs)).toBe(true);
    expect(matchesAnyGlob("specs/a/b/c/spec.md", globs)).toBe(true);
    expect(matchesAnyGlob("specs/auth/notes.md", globs)).toBe(false);
    expect(matchesAnyGlob("src/index.ts", globs)).toBe(false);
  });

  it("never matches when globs are empty", () => {
    expect(matchesAnyGlob("specs/auth/spec.md", [])).toBe(false);
  });

  it("affectedSpecs filters a push's changed paths", () => {
    const event = {
      owner: "acme",
      name: "repo",
      ref: "main",
      changedPaths: ["specs/auth/spec.md", "README.md", "specs/billing/spec.md"],
    };
    expect(affectedSpecs(event, globs)).toEqual([
      "specs/auth/spec.md",
      "specs/billing/spec.md",
    ]);
  });
});

describe("parsePushEvent", () => {
  it("normalizes a branch push and de-dupes changed paths", () => {
    const event = parsePushEvent({
      ref: "refs/heads/main",
      repository: { name: "repo", owner: { login: "acme" } },
      commits: [
        { added: ["specs/a/spec.md"], modified: ["specs/b/spec.md"] },
        { modified: ["specs/a/spec.md"], removed: ["specs/c/spec.md"] },
      ],
    });
    expect(event).toEqual({
      owner: "acme",
      name: "repo",
      ref: "main",
      changedPaths: ["specs/a/spec.md", "specs/b/spec.md", "specs/c/spec.md"],
    });
  });

  it("returns null for non-branch refs and missing repo coords", () => {
    expect(parsePushEvent({ ref: "refs/tags/v1", repository: { name: "r", owner: { login: "o" } } })).toBeNull();
    expect(parsePushEvent({ ref: "refs/heads/main", repository: { owner: { login: "o" } } })).toBeNull();
    expect(parsePushEvent({})).toBeNull();
  });
});

describe("parsePullRequestEvent", () => {
  const repo = { name: "repo", owner: { login: "acme" } };

  it("normalizes an open PR", () => {
    expect(
      parsePullRequestEvent({
        repository: repo,
        pull_request: { number: 7, state: "open", merged: false, title: "Add SSO" },
      }),
    ).toEqual({ owner: "acme", name: "repo", kind: "pull_request", number: 7, state: "open", title: "Add SSO" });
  });

  it("surfaces a merged PR as state 'merged' (not 'closed')", () => {
    const event = parsePullRequestEvent({
      repository: repo,
      pull_request: { number: 7, state: "closed", merged: true, title: "Add SSO" },
    });
    expect(event?.state).toBe("merged");
  });

  it("returns null when fields are missing", () => {
    expect(parsePullRequestEvent({ repository: repo })).toBeNull();
    expect(parsePullRequestEvent({ pull_request: { number: 1, state: "open" } })).toBeNull();
    expect(parsePullRequestEvent({})).toBeNull();
  });
});

describe("parseIssuesEvent", () => {
  it("normalizes an issue", () => {
    expect(
      parseIssuesEvent({
        repository: { name: "repo", owner: { login: "acme" } },
        issue: { number: 12, state: "closed", title: "Bug" },
      }),
    ).toEqual({ owner: "acme", name: "repo", kind: "issue", number: 12, state: "closed", title: "Bug" });
  });

  it("returns null when fields are missing", () => {
    expect(parseIssuesEvent({ issue: { number: 1, state: "open" } })).toBeNull();
    expect(parseIssuesEvent({})).toBeNull();
  });
});

describe("injectSpecId", () => {
  it("inserts an id into existing frontmatter", () => {
    const raw = "---\ntitle: Auth\n---\n\nBody";
    expect(injectSpecId(raw, "abc")).toBe("---\ntitle: Auth\nid: abc\n---\n\nBody");
  });

  it("creates a frontmatter block when none exists", () => {
    expect(injectSpecId("# Heading\n", "abc")).toBe("---\nid: abc\n---\n\n# Heading\n");
  });
});

/** In-memory client that records writes, for reconcile tests. */
class FakeClient implements GitRepoClient {
  writes: WriteFileInput[] = [];
  constructor(private files: SpecFile[]) {}

  listSpecFiles(): Promise<SpecFile[]> {
    return Promise.resolve(this.files);
  }
  readFile(path: string): Promise<SpecFile> {
    const file = this.files.find((f) => f.path === path);
    if (!file) throw new Error(`no such file: ${path}`);
    return Promise.resolve(file);
  }
  writeFile(input: WriteFileInput): Promise<{ commitSha: string; blobSha: string }> {
    this.writes.push(input);
    return Promise.resolve({ commitSha: "commit-sha", blobSha: "new-blob-sha" });
  }
  deleteFile(): Promise<{ commitSha: string }> {
    return Promise.resolve({ commitSha: "commit-sha" });
  }
}

describe("reconcileSpecs", () => {
  it("passes through specs that already have an id without writing", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const raw = `---\nid: ${id}\ntitle: Auth\n---\n\nBody`;
    const client = new FakeClient([{ path: "specs/auth/spec.md", blobSha: "sha1", raw }]);

    const result = await reconcileSpecs(client, ["specs/**/spec.md"]);

    expect(client.writes).toHaveLength(0);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: "specs/auth/spec.md", blobSha: "sha1", idInjected: false });
    expect(result[0]!.spec.frontmatter.id).toBe(id);
  });

  it("injects + commits an id, then tracks the new blob sha", async () => {
    const raw = "---\ntitle: Billing\n---\n\nBody";
    const client = new FakeClient([{ path: "specs/billing/spec.md", blobSha: "old", raw }]);

    const result = await reconcileSpecs(client, ["specs/**/spec.md"]);

    expect(client.writes).toHaveLength(1);
    expect(client.writes[0]).toMatchObject({ path: "specs/billing/spec.md", mode: "direct" });
    expect(result[0]).toMatchObject({ idInjected: true, blobSha: "new-blob-sha" });
    expect(result[0]!.spec.frontmatter.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("skips an unparseable spec instead of failing the whole sync", async () => {
    const goodId = "22222222-2222-4222-8222-222222222222";
    const good = `---\nid: ${goodId}\ntitle: Good\n---\n\nBody`;
    // Missing the required `title`, so parseSpec throws for this one file.
    const bad = "---\nid: 33333333-3333-4333-8333-333333333333\n---\n\nBody";
    const client = new FakeClient([
      { path: "specs/bad/spec.md", blobSha: "sha-bad", raw: bad },
      { path: "specs/good/spec.md", blobSha: "sha-good", raw: good },
    ]);

    const result = await reconcileSpecs(client, ["specs/**/spec.md"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: "specs/good/spec.md", idInjected: false });
    expect(result[0]!.spec.frontmatter.id).toBe(goodId);
  });
});

/** Octokit stub covering the contents-API surface GitHubRepoClient touches. */
function fakeOctokit(behavior: {
  getContent?: () => Promise<{ data: unknown }>;
  createOrUpdateFileContents?: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  deleteFile?: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  listPulls?: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>;
  createPull?: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  createRef?: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
}) {
  return {
    rest: {
      repos: {
        getContent:
          behavior.getContent ??
          (() => Promise.reject(Object.assign(new Error("not found"), { status: 404 }))),
        createOrUpdateFileContents:
          behavior.createOrUpdateFileContents ??
          (() => Promise.resolve({ data: { commit: { sha: "c1" }, content: { sha: "b1" } } })),
        deleteFile:
          behavior.deleteFile ?? (() => Promise.resolve({ data: { commit: { sha: "c2" } } })),
      },
      pulls: {
        list: behavior.listPulls ?? (() => Promise.resolve({ data: [] })),
        create:
          behavior.createPull ??
          (() => Promise.resolve({ data: { number: 1, html_url: "https://pr/1" } })),
      },
      git: {
        getRef: () => Promise.resolve({ data: { object: { sha: "basesha0deadbeef" } } }),
        createRef: behavior.createRef ?? (() => Promise.resolve({ data: {} })),
      },
    },
  } as unknown as ConstructorParameters<typeof GitHubRepoClient>[0];
}

/** A `pulls.list` response entry, trimmed to the fields the client reads. */
function openPull(number: number, url: string) {
  return { number, html_url: url };
}

const REPO = { owner: "acme", name: "docs", ref: "main" };

describe("GitHubRepoClient pull request writes", () => {
  const SPEC = { path: "specs/auth/spec.md", content: "hi", message: "docs: auth" } as const;
  const BRANCH = "specboards/specs-auth-spec-md";

  it("commits to the file's own branch and opens a pull request", async () => {
    const commits: Record<string, unknown>[] = [];
    const refs: Record<string, unknown>[] = [];
    const pulls: Record<string, unknown>[] = [];
    const octokit = fakeOctokit({
      createOrUpdateFileContents: (params) => {
        commits.push(params);
        return Promise.resolve({ data: { commit: { sha: "c1" }, content: { sha: "b1" } } });
      },
      createRef: (params) => {
        refs.push(params);
        return Promise.resolve({ data: {} });
      },
      createPull: (params) => {
        pulls.push(params);
        return Promise.resolve({ data: { number: 42, html_url: "https://gh/pull/42" } });
      },
    });

    const result = await new GitHubRepoClient(octokit, REPO).writeFile({
      ...SPEC,
      mode: "pr",
    });

    expect(refs[0]!.ref).toBe(`refs/heads/${BRANCH}`);
    expect(commits[0]!.branch).toBe(BRANCH);
    expect(pulls[0]).toMatchObject({ head: BRANCH, base: "main", title: "docs: auth" });
    expect(result.pullRequest).toEqual({
      number: 42,
      url: "https://gh/pull/42",
      branch: BRANCH,
      created: true,
    });
  });

  it("adds a second edit to the pull request already open for the file", async () => {
    // The whole point of the stable branch name: three typo fixes are one
    // review, not three.
    const commits: Record<string, unknown>[] = [];
    let branched = false;
    let opened = false;
    const octokit = fakeOctokit({
      listPulls: (params) => {
        expect(params.head).toBe(`acme:${BRANCH}`);
        expect(params.state).toBe("open");
        return Promise.resolve({ data: [openPull(42, "https://gh/pull/42")] });
      },
      createOrUpdateFileContents: (params) => {
        commits.push(params);
        return Promise.resolve({ data: { commit: { sha: "c2" }, content: { sha: "b2" } } });
      },
      createRef: () => {
        branched = true;
        return Promise.resolve({ data: {} });
      },
      createPull: () => {
        opened = true;
        return Promise.resolve({ data: { number: 43, html_url: "https://gh/pull/43" } });
      },
    });

    const result = await new GitHubRepoClient(octokit, REPO).writeFile({
      ...SPEC,
      mode: "pr",
    });

    expect(branched).toBe(false);
    expect(opened).toBe(false);
    expect(commits[0]!.branch).toBe(BRANCH);
    expect(result.pullRequest).toEqual({
      number: 42,
      url: "https://gh/pull/42",
      branch: BRANCH,
      created: false,
    });
  });

  it("never revives a leftover branch whose pull request is closed", async () => {
    // The branch survived a merged or rejected pull request. Committing onto it
    // would carry those changes into the new proposal, so branch elsewhere.
    const octokit = fakeOctokit({
      listPulls: () => Promise.resolve({ data: [] }),
      createRef: (params) =>
        params.ref === `refs/heads/${BRANCH}`
          ? Promise.reject(Object.assign(new Error("exists"), { status: 422 }))
          : Promise.resolve({ data: {} }),
      createPull: (params) =>
        Promise.resolve({ data: { number: 44, html_url: `https://gh/pull/44?h=${params.head}` } }),
    });

    const result = await new GitHubRepoClient(octokit, REPO).writeFile({
      ...SPEC,
      mode: "pr",
    });

    expect(result.pullRequest?.branch).toBe(`${BRANCH}-basesha0`);
    expect(result.pullRequest?.created).toBe(true);
  });

  it("reports the pull request that won a create race rather than failing", async () => {
    // The commit has already landed by then, so a 422 here is not a failed save.
    let listed = 0;
    const octokit = fakeOctokit({
      listPulls: () =>
        Promise.resolve({ data: listed++ === 0 ? [] : [openPull(45, "https://gh/pull/45")] }),
      createPull: () => Promise.reject(Object.assign(new Error("already exists"), { status: 422 })),
    });

    const result = await new GitHubRepoClient(octokit, REPO).writeFile({
      ...SPEC,
      mode: "pr",
    });

    expect(result.pullRequest).toMatchObject({ number: 45, created: false });
  });

  it("direct mode commits to the ref and proposes nothing", async () => {
    const commits: Record<string, unknown>[] = [];
    const octokit = fakeOctokit({
      createOrUpdateFileContents: (params) => {
        commits.push(params);
        return Promise.resolve({ data: { commit: { sha: "c1" }, content: { sha: "b1" } } });
      },
    });

    const result = await new GitHubRepoClient(octokit, REPO).writeFile({
      ...SPEC,
      mode: "direct",
    });

    expect(commits[0]!.branch).toBe("main");
    expect(result.pullRequest).toBeUndefined();
  });
});

describe("GitHubRepoClient guarded writes", () => {
  it("sends the expected blob sha and skips the lookup on a guarded update", async () => {
    const sent: Record<string, unknown>[] = [];
    let lookedUp = false;
    const octokit = fakeOctokit({
      getContent: () => {
        lookedUp = true;
        return Promise.resolve({ data: { type: "file", sha: "other" } });
      },
      createOrUpdateFileContents: (params) => {
        sent.push(params);
        return Promise.resolve({ data: { commit: { sha: "c1" }, content: { sha: "b2" } } });
      },
    });
    const client = new GitHubRepoClient(octokit, REPO);

    const result = await client.writeFile({
      path: "notes.md",
      content: "hi",
      message: "m",
      mode: "direct",
      expectedBlobSha: "b1",
    });

    expect(lookedUp).toBe(false);
    expect(sent[0]!.sha).toBe("b1");
    expect(result.blobSha).toBe("b2");
  });

  it("turns a stale-sha rejection into GitWriteConflictError", async () => {
    const octokit = fakeOctokit({
      createOrUpdateFileContents: () =>
        Promise.reject(Object.assign(new Error("conflict"), { status: 409 })),
    });
    const client = new GitHubRepoClient(octokit, REPO);

    await expect(
      client.writeFile({
        path: "notes.md",
        content: "hi",
        message: "m",
        mode: "direct",
        expectedBlobSha: "stale",
      }),
    ).rejects.toBeInstanceOf(GitWriteConflictError);
  });

  it("guarded create (null) sends no sha and maps 422 to a conflict", async () => {
    const sent: Record<string, unknown>[] = [];
    const octokit = fakeOctokit({
      createOrUpdateFileContents: (params) => {
        sent.push(params);
        return Promise.reject(Object.assign(new Error("exists"), { status: 422 }));
      },
    });
    const client = new GitHubRepoClient(octokit, REPO);

    await expect(
      client.writeFile({
        path: "new.md",
        content: "hi",
        message: "m",
        mode: "direct",
        expectedBlobSha: null,
      }),
    ).rejects.toBeInstanceOf(GitWriteConflictError);
    expect("sha" in sent[0]!).toBe(false);
  });

  it("unguarded writes still look up the current sha and pass errors through", async () => {
    const octokit = fakeOctokit({
      getContent: () => Promise.resolve({ data: { type: "file", sha: "current" } }),
      createOrUpdateFileContents: () =>
        Promise.reject(Object.assign(new Error("boom"), { status: 422 })),
    });
    const client = new GitHubRepoClient(octokit, REPO);

    await expect(
      client.writeFile({ path: "spec.md", content: "x", message: "m", mode: "direct" }),
    ).rejects.toThrow("boom");
  });

  it("deletes with the guard sha and flags an already-deleted file", async () => {
    const sent: Record<string, unknown>[] = [];
    const octokit = fakeOctokit({
      deleteFile: (params) => {
        sent.push(params);
        return Promise.resolve({ data: { commit: { sha: "c9" } } });
      },
    });
    const client = new GitHubRepoClient(octokit, REPO);

    const result = await client.deleteFile({
      path: "old.md",
      message: "m",
      expectedBlobSha: "b1",
    });
    expect(result.commitSha).toBe("c9");
    expect(sent[0]!.sha).toBe("b1");

    // No expected sha and the file is gone (getContent 404s): conflict.
    await expect(client.deleteFile({ path: "gone.md", message: "m" })).rejects.toBeInstanceOf(
      GitWriteConflictError,
    );
  });
});
