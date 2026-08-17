import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { attributionAddress, specCommitMessage } from "@/lib/commit-attribution";

/**
 * What a spec commit says about who wrote it.
 *
 * Two readers to satisfy, and they want different things. An engineer scanning
 * `git log --oneline` gets one line, so that line has to say who changed which
 * spec; `docs(specboard): update specs/refunds/spec.md` spends it on the least
 * useful of the available facts. GitHub reads the trailer, which is what turns
 * an author with no GitHub account into a named co-author rather than an
 * anonymous app commit.
 */

const author = {
  name: "Jane Doe",
  email: "jane-doe-8f3a2b1c@users.noreply.specboards.ai",
};

describe("attributionAddress", () => {
  it("is readable, non-routable, and carries no real address", () => {
    const address = attributionAddress("user-1", "Jane Doe");
    expect(address).toBe(
      `jane-doe-${createHash("sha256").update("user-1").digest("hex").slice(0, 8)}@users.noreply.specboards.ai`,
    );
  });

  it("is stable for the same person, so their commits group together", () => {
    expect(attributionAddress("user-1", "Jane Doe")).toBe(
      attributionAddress("user-1", "Jane Doe"),
    );
  });

  it("keeps two people with the same name apart", () => {
    expect(attributionAddress("user-1", "Jane Doe")).not.toBe(
      attributionAddress("user-2", "Jane Doe"),
    );
  });

  it("does not publish the user id itself", () => {
    expect(attributionAddress("user-1", "Jane Doe")).not.toContain("user-1");
  });

  it("survives a name that is not address-safe", () => {
    expect(attributionAddress("u", "Ana María O'Brien-Smith")).toMatch(
      /^ana-mar-a-o-brien-smith-[0-9a-f]{8}@users\.noreply\.specboards\.ai$/,
    );
    // A name with nothing usable in it still has to produce a valid address.
    expect(attributionAddress("u", "***")).toMatch(
      /^author-[0-9a-f]{8}@users\.noreply\.specboards\.ai$/,
    );
  });
});

describe("specCommitMessage", () => {
  it("names the person and the spec in the subject", () => {
    const subject = specCommitMessage({
      action: "update",
      title: "Refund policy",
      path: "specs/refunds/spec.md",
      author,
    }).split("\n")[0];
    expect(subject).toBe("docs(spec): Jane Doe updated Refund policy");
  });

  it("uses the right verb for each kind of write", () => {
    const subject = (action: "update" | "create" | "remove") =>
      specCommitMessage({ action, title: "Refunds", path: "p.md", author }).split("\n")[0];
    expect(subject("create")).toContain("added Refunds");
    expect(subject("remove")).toContain("removed Refunds");
  });

  it("adds a co-author trailer in the shape git parses", () => {
    const message = specCommitMessage({
      action: "update",
      title: "Refunds",
      path: "specs/refunds/spec.md",
      author,
    });
    // Must be the last line and exactly this shape, or it is not a trailer.
    expect(message.split("\n").at(-1)).toBe(
      "Co-authored-by: Jane Doe <jane-doe-8f3a2b1c@users.noreply.specboards.ai>",
    );
    // Separated from the body by a blank line, which the trailer format needs.
    expect(message).toMatch(/\n\nCo-authored-by: /);
  });

  it("keeps the path in the body where a tool can still find it", () => {
    const message = specCommitMessage({
      action: "update",
      title: "Refunds",
      path: "specs/refunds/spec.md",
      author,
    });
    expect(message).toContain("specs/refunds/spec.md");
    expect(message.split("\n")[0]).not.toContain("specs/refunds/spec.md");
  });

  it("carries no co-author when there is no person to credit", () => {
    const message = specCommitMessage({
      action: "update",
      title: "Refunds",
      path: "specs/refunds/spec.md",
      author: null,
    });
    // A commit credited to nobody beats one credited to a placeholder, which
    // looks like an answer.
    expect(message).not.toContain("Co-authored-by");
    expect(message.split("\n")[0]).toBe("docs(spec): update Refunds");
  });

  it("keeps a multi-line title from breaking the subject", () => {
    const message = specCommitMessage({
      action: "update",
      title: "Refunds\nand returns   policy",
      path: "p.md",
      author,
    });
    expect(message.split("\n")[0]).toBe(
      "docs(spec): Jane Doe updated Refunds and returns policy",
    );
  });

  it("never puts a real email address in the repo", () => {
    // The trailer format makes an address structurally mandatory, so the guard
    // is that the one it carries is minted. A commit cannot be unpublished, and
    // the repo it lands in is often public and always outside our control.
    const message = specCommitMessage({
      action: "update",
      title: "Refunds",
      path: "p.md",
      author: { name: "Jane Doe", email: attributionAddress("u-1", "Jane Doe") },
    });
    const addresses = message.match(/<([^>]+)>/g) ?? [];
    expect(addresses).not.toHaveLength(0);
    for (const address of addresses) {
      expect(address).toContain("@users.noreply.specboards.ai");
    }
  });

  it("falls back to the path when a spec has no usable title", () => {
    const message = specCommitMessage({
      action: "update",
      title: "   ",
      path: "specs/refunds/spec.md",
      author,
    });
    expect(message.split("\n")[0]).toContain("specs/refunds/spec.md");
  });
});

/**
 * A commit that carries text the assistant drafted.
 *
 * The question this has to answer is the one someone asks in six months when a
 * requirement surprises them: did a person write this, or did a person approve
 * it? `git log` is where they will look, and a subject reading "Jane updated
 * Refund policy" is not false so much as unanswerable.
 */
describe("a commit for an edit the assistant drafted", () => {
  it("says accepted, not updated, and names what it was", () => {
    const subject = specCommitMessage({
      action: "update",
      title: "Refund policy",
      path: "specs/refunds/spec.md",
      author,
      assistantDrafted: true,
    }).split("\n")[0];
    expect(subject).toBe(
      "docs(spec): Jane Doe accepted an assistant edit to Refund policy",
    );
  });

  it("still credits the person, not the model", () => {
    // Naming the model as co-author would attribute a requirement to something
    // that cannot be asked about it afterwards. The accountable party is the
    // person who read the diff and said yes.
    const message = specCommitMessage({
      action: "update",
      title: "Refund policy",
      path: "specs/refunds/spec.md",
      author,
      assistantDrafted: true,
    });
    expect(message.split("\n").at(-1)).toBe(
      "Co-authored-by: Jane Doe <jane-doe-8f3a2b1c@users.noreply.specboards.ai>",
    );
    expect(message).toContain("Drafted by the Specboards assistant");
  });

  it("still reads as an accept with nobody to credit", () => {
    // The common case for a customer whose author connected a GitHub account:
    // the commit is genuinely theirs, so there is no trailer, and the subject
    // is the only thing left that can carry the distinction.
    const subject = specCommitMessage({
      action: "update",
      title: "Refund policy",
      path: "p.md",
      author: null,
      assistantDrafted: true,
    }).split("\n")[0];
    expect(subject).toBe("docs(spec): accept an assistant edit to Refund policy");
  });

  it("leaves an ordinary edit's wording alone", () => {
    const message = specCommitMessage({
      action: "update",
      title: "Refund policy",
      path: "p.md",
      author,
    });
    expect(message).toContain("Edited in Specboards.");
    expect(message).not.toContain("assistant");
  });
});
