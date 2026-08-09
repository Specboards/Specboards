import { describe, expect, it } from "vitest";

import {
  draftAge,
  draftKey,
  hasMovedSince,
  isDraftWorthOffering,
  type SpecDraft,
} from "@/lib/spec-draft";

/**
 * Deciding whether to interrupt someone with a recovered draft.
 *
 * Both errors are real. Never offering loses an afternoon's writing. Offering
 * too eagerly trains people to dismiss the prompt, so it is gone by the one
 * occasion it mattered.
 */

function draft(over: Partial<SpecDraft> = {}): SpecDraft {
  return {
    body: "Some unfinished writing",
    savedAt: "2026-08-08T12:00:00.000Z",
    baseSha: "sha-a",
    ...over,
  };
}

describe("isDraftWorthOffering", () => {
  it("offers writing that never reached git", () => {
    expect(isDraftWorthOffering(draft(), "The published text")).toBe(true);
  });

  it("stays quiet when there is nothing to recover", () => {
    expect(isDraftWorthOffering(null, "anything")).toBe(false);
    // Identical to what is already on screen is noise, not a recovery.
    expect(isDraftWorthOffering(draft({ body: "Same" }), "Same")).toBe(false);
    // Whitespace-only difference is the same non-event.
    expect(isDraftWorthOffering(draft({ body: "  Same\n" }), "Same")).toBe(false);
  });

  it("ignores a stored value that is not a draft", () => {
    // An older version's shape, or something else entirely under the same key.
    expect(
      isDraftWorthOffering({ savedAt: "", baseSha: null } as unknown as SpecDraft, "x"),
    ).toBe(false);
  });
});

describe("hasMovedSince", () => {
  it("notices the spec changed under the draft", () => {
    // Restoring on top of somebody else's rewrite is exactly when an author
    // needs telling before they choose, not after they save.
    expect(hasMovedSince(draft(), "sha-b")).toBe(true);
    expect(hasMovedSince(draft(), "sha-a")).toBe(false);
  });

  it("does not claim movement it cannot know about", () => {
    expect(hasMovedSince(draft({ baseSha: null }), "sha-b")).toBe(false);
    expect(hasMovedSince(draft(), null)).toBe(false);
  });
});

describe("draftAge", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("reads as a person would say it", () => {
    expect(draftAge(ago(30_000), now)).toBe("just now");
    expect(draftAge(ago(60_000), now)).toBe("1 minute ago");
    expect(draftAge(ago(45 * 60_000), now)).toBe("45 minutes ago");
    expect(draftAge(ago(3 * 3_600_000), now)).toBe("3 hours ago");
    expect(draftAge(ago(50 * 3_600_000), now)).toBe("2 days ago");
  });

  it("does not report a future draft as negative time", () => {
    // Clock skew between writing and reading should not produce nonsense.
    expect(draftAge(new Date(now.getTime() + 60_000).toISOString(), now)).toBe(
      "just now",
    );
    expect(draftAge("not a date", now)).toBe("just now");
  });
});

describe("draftKey", () => {
  it("namespaces per spec so one item's draft cannot surface on another", () => {
    expect(draftKey("abc")).toBe("specboards:draft:abc");
    expect(draftKey("abc")).not.toBe(draftKey("abd"));
  });
});
