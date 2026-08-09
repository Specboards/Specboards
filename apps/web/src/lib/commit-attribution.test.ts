import { describe, expect, it } from "vitest";

import { specCommitMessage } from "@/lib/commit-attribution";

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

const author = { name: "Jane Doe", email: "jane@acme.com" };

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

  it("adds a co-author trailer GitHub can match to an account", () => {
    const message = specCommitMessage({
      action: "update",
      title: "Refunds",
      path: "specs/refunds/spec.md",
      author,
    });
    // Must be the last line and exactly this shape, or GitHub ignores it.
    expect(message.split("\n").at(-1)).toBe(
      "Co-authored-by: Jane Doe <jane@acme.com>",
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
