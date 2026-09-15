import { describe, expect, it } from "vitest";

import {
  MAX_EVIDENCE,
  ProposalPayloadError,
  consequencesOf,
  parseEvidence,
  parseItemMetadata,
  parseSpecContent,
} from "./types";

/**
 * Reading a proposal payload that an agent we did not write put in the
 * database.
 *
 * The cases below are the ways a payload arrives wrong in practice: a field
 * the server has never heard of, a null that means something, a null that
 * means nothing, and a list that has run away. The split the tests are really
 * checking is the asymmetry: content that cannot be read is refused, because
 * an unreviewable proposal must not sit in a queue pretending to be
 * reviewable; a citation that cannot be read is dropped, because three good
 * sources and one bad link is still a reviewable proposal.
 */

describe("a whole replacement body", () => {
  it("reads one", () => {
    expect(parseSpecContent({ body: "# Title\n\nWords." })).toEqual({
      body: "# Title\n\nWords.",
    });
  });

  it("refuses an empty one, rather than letting Apply clear a document", () => {
    expect(() => parseSpecContent({ body: "   " })).toThrow(ProposalPayloadError);
    expect(() => parseSpecContent({})).toThrow(ProposalPayloadError);
    expect(() => parseSpecContent(null)).toThrow(ProposalPayloadError);
  });
});

describe("a metadata change set", () => {
  it("reads the fields it knows", () => {
    expect(
      parseItemMetadata({
        status: "ready",
        tags: ["api", "urgent"],
        assigneeId: "u-1",
      }),
    ).toEqual({ status: "ready", tags: ["api", "urgent"], assigneeId: "u-1" });
  });

  it("drops a field this server has never heard of", () => {
    // A newer agent talking to an older server should degrade to proposing
    // what this server understands, not fail outright.
    const patch = parseItemMetadata({ status: "ready", warpFactor: 9 });
    expect(patch).toEqual({ status: "ready" });
    expect("warpFactor" in patch).toBe(false);
  });

  it("keeps a null, because unassigning is a real instruction", () => {
    expect(parseItemMetadata({ assigneeId: null })).toEqual({ assigneeId: null });
    expect(parseItemMetadata({ releaseId: null })).toEqual({ releaseId: null });
  });

  it("keeps an empty tag list, which means clear the tags", () => {
    expect(parseItemMetadata({ tags: [] })).toEqual({ tags: [] });
  });

  it("drops non-string members of a tag list", () => {
    expect(parseItemMetadata({ tags: ["api", 7, null, "ux"] })).toEqual({
      tags: ["api", "ux"],
    });
  });

  it("refuses a change set that changes nothing", () => {
    // A reviewer asked to approve a no-op has been handed a malformed
    // proposal, and saying so is more use than an empty diff.
    expect(() => parseItemMetadata({})).toThrow(ProposalPayloadError);
    expect(() => parseItemMetadata({ warpFactor: 9 })).toThrow(
      ProposalPayloadError,
    );
    expect(() => parseItemMetadata("ready")).toThrow(ProposalPayloadError);
  });

  it("ignores details, which is the other kind's job", () => {
    expect(() => parseItemMetadata({ details: "new body" })).toThrow(
      ProposalPayloadError,
    );
  });
});

describe("what a reviewer is warned about", () => {
  it("says a stage change can fire gates and notify people", () => {
    expect(consequencesOf({ status: "ready" })).toHaveLength(1);
    expect(consequencesOf({ status: "ready" })[0]).toMatch(/stage gates/i);
  });

  it("says nothing about a tag change", () => {
    expect(consequencesOf({ tags: ["api"] })).toEqual([]);
  });
});

describe("evidence", () => {
  it("reads internal and external citations", () => {
    expect(
      parseEvidence([
        { kind: "idea", ref: "idea-1", label: "Three people asked" },
        { kind: "url", ref: "https://example.com/pricing" },
      ]),
    ).toEqual([
      { kind: "idea", ref: "idea-1", label: "Three people asked" },
      {
        kind: "url",
        ref: "https://example.com/pricing",
        label: "https://example.com/pricing",
      },
    ]);
  });

  it("drops a bad entry instead of failing the proposal", () => {
    const out = parseEvidence([
      { kind: "idea", ref: "idea-1" },
      { kind: "telepathy", ref: "x" },
      { kind: "url", ref: "javascript:alert(1)" },
      null,
      "nope",
      { kind: "item", ref: "" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.ref).toBe("idea-1");
  });

  it("refuses a url citation that is not a url", () => {
    // Every `url` row the reader sees should be clickable, so an entry that
    // would render as unclickable text is not a citation.
    expect(parseEvidence([{ kind: "url", ref: "see the docs" }])).toEqual([]);
  });

  it("caps a runaway list", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      kind: "item" as const,
      ref: `i-${i}`,
    }));
    expect(parseEvidence(many)).toHaveLength(MAX_EVIDENCE);
  });

  it("treats a non-list as no evidence", () => {
    expect(parseEvidence(undefined)).toEqual([]);
    expect(parseEvidence({ kind: "idea", ref: "x" })).toEqual([]);
  });
});
