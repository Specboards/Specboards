import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  reconcileSpecs,
  injectSpecId,
  type GitRepoClient,
  type SpecFile,
  type WriteFileInput,
} from "./index.js";
import {
  affectedSpecs,
  matchesAnyGlob,
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
});
