import { describe, expect, it } from "vitest";

import {
  InvalidGithubLinkError,
  parseGithubLinkInput,
  pickRepo,
  splitRepoSlug,
} from "./github-links-service";

/**
 * The `link_github` MCP tool reuses parseGithubLinkInput for its input
 * validation, so these cover the tool's accepted shapes and error messages
 * (acceptance: invalid PR numbers / kinds return a clear error).
 */
describe("parseGithubLinkInput", () => {
  it("accepts a pull request by number", () => {
    expect(parseGithubLinkInput({ kind: "pull_request", number: 42 })).toEqual({
      kind: "pull_request",
      number: 42,
    });
  });

  it("accepts an issue by number", () => {
    expect(parseGithubLinkInput({ kind: "issue", number: 7 })).toEqual({
      kind: "issue",
      number: 7,
    });
  });

  it("accepts a branch and trims its name", () => {
    expect(
      parseGithubLinkInput({ kind: "branch", branch: "  feat/x  " }),
    ).toEqual({ kind: "branch", branch: "feat/x" });
  });

  it("ignores a stray number on a branch link", () => {
    expect(
      parseGithubLinkInput({ kind: "branch", branch: "main", number: 3 }),
    ).toEqual({ kind: "branch", branch: "main" });
  });

  it("rejects an unknown kind", () => {
    expect(() => parseGithubLinkInput({ kind: "commit", number: 1 })).toThrow(
      InvalidGithubLinkError,
    );
  });

  it("rejects a non-object body", () => {
    expect(() => parseGithubLinkInput(null)).toThrow(InvalidGithubLinkError);
    expect(() => parseGithubLinkInput([])).toThrow(InvalidGithubLinkError);
    expect(() => parseGithubLinkInput("pull_request")).toThrow(
      InvalidGithubLinkError,
    );
  });

  it("rejects a non-integer, zero, or negative PR number", () => {
    expect(() =>
      parseGithubLinkInput({ kind: "pull_request", number: 1.5 }),
    ).toThrow(InvalidGithubLinkError);
    expect(() =>
      parseGithubLinkInput({ kind: "pull_request", number: 0 }),
    ).toThrow(InvalidGithubLinkError);
    expect(() =>
      parseGithubLinkInput({ kind: "issue", number: -3 }),
    ).toThrow(InvalidGithubLinkError);
    expect(() => parseGithubLinkInput({ kind: "issue" })).toThrow(
      InvalidGithubLinkError,
    );
  });

  it("rejects an empty or missing branch name", () => {
    expect(() =>
      parseGithubLinkInput({ kind: "branch", branch: "   " }),
    ).toThrow(InvalidGithubLinkError);
    expect(() => parseGithubLinkInput({ kind: "branch" })).toThrow(
      InvalidGithubLinkError,
    );
  });
});

/**
 * Repo disambiguation for a link. A DB-native card has no `repoId` of its own,
 * so the service falls back to the card's product and then the workspace; these
 * cover the pure decisions in that ladder (the DB traversal itself is exercised
 * by the integration suite).
 */
describe("link repo selection", () => {
  const spec = { isSpecRepo: true, owner: "acme", name: "specs" };
  const app = { isSpecRepo: false, owner: "acme", name: "app" };
  const infra = { isSpecRepo: false, owner: "acme", name: "infra" };

  it("accepts an explicit repo and trims it", () => {
    expect(
      parseGithubLinkInput({
        kind: "pull_request",
        number: 190,
        repo: "  acme/app  ",
      }),
    ).toEqual({ kind: "pull_request", number: 190, repo: "acme/app" });
  });

  it("treats a null repo as absent, so the repo is inferred", () => {
    expect(
      parseGithubLinkInput({ kind: "pull_request", number: 1, repo: null }),
    ).toEqual({ kind: "pull_request", number: 1, repo: undefined });
  });

  it("rejects a repo that isn't owner/name", () => {
    for (const bad of ["app", "acme/", "/app", "a/b/c"]) {
      expect(() => splitRepoSlug(bad)).toThrow(InvalidGithubLinkError);
    }
    expect(splitRepoSlug("acme/app")).toEqual(["acme", "app"]);
  });

  it("rejects an empty repo string outright", () => {
    expect(() =>
      parseGithubLinkInput({ kind: "issue", number: 1, repo: "   " }),
    ).toThrow(InvalidGithubLinkError);
  });

  it("uses the only candidate, whether or not it is the spec repo", () => {
    expect(pickRepo([app])).toBe(app);
    expect(pickRepo([spec])).toBe(spec);
  });

  it("breaks a tie in favour of the workspace spec repo", () => {
    expect(pickRepo([app, spec, infra])).toBe(spec);
  });

  it("refuses to guess between several non-spec repos", () => {
    // The caller is asked to pass `repo`; guessing would resolve a PR number
    // against the wrong project.
    expect(pickRepo([app, infra])).toBeNull();
  });

  it("has nothing to pick from an empty tier", () => {
    expect(pickRepo([])).toBeNull();
  });
});
