import { describe, expect, it } from "vitest";

import { pendingSpecChanges } from "@/lib/pending-changes";
import type { GithubLink } from "@/lib/store/types";

/**
 * Every case here is a way of telling someone their spec is waiting for review
 * when it is not. The panel this feeds is read by people deciding whether the
 * text in front of them is current, so a false positive sends them looking for
 * an edit that does not exist, and a false negative lets two authors write
 * competing versions of the same section.
 */

function link(over: Partial<GithubLink> = {}): GithubLink {
  return {
    id: "l1",
    kind: "pull_request",
    number: 7,
    branch: null,
    url: "https://github.test/pull/7",
    title: "Update spec",
    state: "open",
    headBranch: "specboards/specs-billing-spec-md",
    sourceSpecId: "s1",
    sourceTitle: "Billing",
    inherited: false,
    ...over,
  };
}

describe("pendingSpecChanges", () => {
  it("counts an open pull request the spec write path opened", () => {
    expect(pendingSpecChanges([link()])).toHaveLength(1);
  });

  it("ignores a pull request someone linked by hand", () => {
    // The distinguishing mark, and the reason the column exists: a card linked
    // to the PR that implements it has no pending change to its spec.
    expect(pendingSpecChanges([link({ headBranch: null })])).toEqual([]);
  });

  it("ignores a review that is finished", () => {
    expect(pendingSpecChanges([link({ state: "merged" })])).toEqual([]);
    expect(pendingSpecChanges([link({ state: "closed" })])).toEqual([]);
  });

  it("ignores a proposal against a descendant's spec", () => {
    // Real, pending, and about a different document than the one on screen.
    expect(pendingSpecChanges([link({ inherited: true })])).toEqual([]);
  });

  it("ignores issues and branches", () => {
    expect(
      pendingSpecChanges([
        link({ kind: "issue" }),
        link({ kind: "branch", state: null }),
      ]),
    ).toEqual([]);
  });

  it("returns every open proposal when more than one is in flight", () => {
    const found = pendingSpecChanges([
      link({ id: "a", number: 1 }),
      link({ id: "b", number: 2 }),
      link({ id: "c", number: 3, state: "merged" }),
    ]);
    expect(found.map((l) => l.number)).toEqual([1, 2]);
  });
});
