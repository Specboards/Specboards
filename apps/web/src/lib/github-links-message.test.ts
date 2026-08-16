import { describe, expect, it } from "vitest";

import { notFoundMessage } from "./github-links-service";

/**
 * The message an agent gets when `link_github` cannot find its pull request.
 *
 * Found by driving the flow: a spec-backed item whose spec lives in the specs
 * repo resolves to that repo, so linking a pull request opened in the code repo
 * failed with "That pull request was not found in <specs repo>." True, and a
 * dead end - it names a repo the caller never mentioned and says nothing about
 * the `repo` argument that fixes it.
 */

describe("notFoundMessage", () => {
  it("points at the repo argument and the repos to try", () => {
    const msg = notFoundMessage("pull_request", "acme/specs", [
      "acme/app",
      "acme/infra",
    ]);
    expect(msg).toContain("acme/specs");
    // The two things the caller needs and did not have: what else there is,
    // and the name of the argument that reaches it.
    expect(msg).toContain("acme/app, acme/infra");
    expect(msg).toContain('repo: "owner/name"');
    // And why that repo was searched, since the caller never named it.
    expect(msg).toContain("resolves to");
  });

  it("stays short when the caller named the repo itself", () => {
    // No alternatives are passed in that case: someone who used `repo` does not
    // need to be told it exists.
    const msg = notFoundMessage("pull_request", "acme/app", []);
    expect(msg).toBe("That pull request was not found in acme/app.");
  });

  it("names the artifact kind in words", () => {
    expect(notFoundMessage("pull_request", "a/b", [])).toContain("pull request");
    expect(notFoundMessage("issue", "a/b", [])).toContain("issue");
    expect(notFoundMessage("branch", "a/b", [])).toContain("branch");
  });
});
