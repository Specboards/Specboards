import { describe, expect, it } from "vitest";

import {
  InvalidGithubLinkError,
  parseGithubLinkInput,
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
