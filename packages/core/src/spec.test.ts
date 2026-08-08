import { describe, expect, it } from "vitest";
import {
  SpecParseError,
  extractSections,
  featureSlug,
  frontmatterBlock,
  hasSpecId,
  parseSpec,
  previewSpec,
  rewriteSpecBody,
  specBody,
  specFilePath,
} from "./spec.js";

const SAMPLE = `---
id: 3f1a8c2e-0b7d-4e2a-9c11-2a6b8d4e1f00
title: Example Feature
kind: feature
---

# Example Feature

Intro paragraph.

## Problem

Users cannot do X.

## Requirements

- Must do A
- Must do B
`;

describe("parseSpec", () => {
  it("parses frontmatter and sections", () => {
    const spec = parseSpec(SAMPLE, "specs/example/spec.md");
    expect(spec.frontmatter.id).toBe("3f1a8c2e-0b7d-4e2a-9c11-2a6b8d4e1f00");
    expect(spec.frontmatter.title).toBe("Example Feature");
    const headings = spec.sections.map((s) => s.heading);
    expect(headings).toContain("Problem");
    expect(headings).toContain("Requirements");
  });

  it("throws on missing id", () => {
    expect(() => parseSpec(`---\ntitle: No ID\n---\nbody`)).toThrow(SpecParseError);
  });
});

describe("hasSpecId", () => {
  it("detects presence/absence of id", () => {
    expect(hasSpecId(SAMPLE)).toBe(true);
    expect(hasSpecId(`---\ntitle: x\n---\nbody`)).toBe(false);
  });
});

describe("previewSpec", () => {
  it("reads the frontmatter title and id presence without throwing", () => {
    const preview = previewSpec(SAMPLE);
    expect(preview.title).toBe("Example Feature");
    expect(preview.hasId).toBe(true);
  });

  it("falls back to the first heading when there's no frontmatter title", () => {
    const preview = previewSpec(`---\nkind: feature\n---\n\n# Checkout flow\n\nbody`);
    expect(preview.title).toBe("Checkout flow");
    expect(preview.hasId).toBe(false);
  });

  it("handles a spec with no frontmatter and no id (not yet imported)", () => {
    const preview = previewSpec(`# Brand new spec\n\nNo frontmatter at all.`);
    expect(preview.title).toBe("Brand new spec");
    expect(preview.hasId).toBe(false);
  });

  it("returns a null title when nothing is derivable", () => {
    const preview = previewSpec(`just some body text with no heading`);
    expect(preview.title).toBeNull();
    expect(preview.hasId).toBe(false);
  });
});

describe("extractSections", () => {
  it("captures heading levels", () => {
    const sections = extractSections("## A\nbody a\n### B\nbody b");
    expect(sections).toHaveLength(2);
    expect(sections[0]!.level).toBe(2);
    expect(sections[1]!.level).toBe(3);
  });
});

describe("frontmatterBlock", () => {
  it("returns the exact frontmatter slice including the closing delimiter", () => {
    const block = frontmatterBlock(SAMPLE);
    expect(block).toBe(
      "---\nid: 3f1a8c2e-0b7d-4e2a-9c11-2a6b8d4e1f00\ntitle: Example Feature\nkind: feature\n---\n",
    );
  });

  it("returns null when there is no frontmatter", () => {
    expect(frontmatterBlock("# Just a heading\n\nbody")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const block = frontmatterBlock("---\r\nid: x\r\n---\r\n# Body");
    expect(block).toBe("---\r\nid: x\r\n---\r\n");
  });
});

describe("rewriteSpecBody", () => {
  it("preserves frontmatter (id, title, kind) verbatim while replacing the body", () => {
    const next = rewriteSpecBody(SAMPLE, "# New title\n\nRewritten by an agent.", {
      id: "unused",
      title: "unused",
    });
    // Frontmatter is byte-for-byte identical; only the body changed.
    expect(next.startsWith(frontmatterBlock(SAMPLE)!)).toBe(true);
    const reparsed = parseSpec(next);
    expect(reparsed.frontmatter.id).toBe("3f1a8c2e-0b7d-4e2a-9c11-2a6b8d4e1f00");
    expect(reparsed.frontmatter.kind).toBe("feature");
    expect(reparsed.content).toContain("Rewritten by an agent.");
    expect(reparsed.content).not.toContain("Users cannot do X.");
  });

  it("normalizes to one blank line after frontmatter and a single trailing newline", () => {
    const next = rewriteSpecBody(SAMPLE, "\n\n# Body\n\n\n", { id: "x", title: "y" });
    expect(next).toContain("---\n\n# Body\n");
    expect(next.endsWith("# Body\n")).toBe(true);
    expect(next.endsWith("\n\n")).toBe(false);
  });

  it("synthesizes minimal frontmatter when the file has none, keeping identity", () => {
    const next = rewriteSpecBody("# Orphan\n\nno frontmatter", "# Body", {
      id: "3f1a8c2e-0b7d-4e2a-9c11-2a6b8d4e1f00",
      title: "Recovered",
    });
    const reparsed = parseSpec(next);
    expect(reparsed.frontmatter.id).toBe("3f1a8c2e-0b7d-4e2a-9c11-2a6b8d4e1f00");
    expect(reparsed.frontmatter.title).toBe("Recovered");
  });
});

describe("featureSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(featureSlug("Attach a Spec")).toBe("attach-a-spec");
  });

  it("collapses runs of punctuation into a single hyphen", () => {
    expect(featureSlug("Spec:  editing / in the app!")).toBe(
      "spec-editing-in-the-app",
    );
  });

  it("trims leading and trailing hyphens", () => {
    expect(featureSlug("  --Hello--  ")).toBe("hello");
  });

  it("is empty when nothing sluggable survives", () => {
    expect(featureSlug("!!! ???")).toBe("");
  });
});

describe("specBody", () => {
  it("returns the body the editor holds, without the frontmatter", () => {
    const body = specBody(SAMPLE);
    expect(body.startsWith("# Example Feature")).toBe(true);
    expect(body).not.toContain("kind: feature");
  });

  it("round-trips with rewriteSpecBody", () => {
    const next = rewriteSpecBody(SAMPLE, "# Rewritten\n\nNew text.", {
      id: "x",
      title: "y",
    });
    expect(specBody(next)).toBe("# Rewritten\n\nNew text.");
  });

  it("reads a file whose frontmatter parseSpec would refuse", () => {
    // This describes the version that won a write conflict, which nobody here
    // wrote and nothing has validated. Withholding the text because its
    // frontmatter is malformed would hide exactly what the author needs to see.
    expect(specBody("---\nid: 7\n---\n\nStill readable.\n")).toBe(
      "Still readable.",
    );
    expect(() => parseSpec("---\nid: 7\n---\n\nStill readable.\n")).toThrow(
      SpecParseError,
    );
  });

  it("treats a file with no frontmatter as all body", () => {
    expect(specBody("# Orphan\n\ntext\n")).toBe("# Orphan\n\ntext");
    expect(specBody("")).toBe("");
  });
});

describe("specFilePath", () => {
  it("builds the path the server will commit to", () => {
    expect(specFilePath("Attach a spec")).toBe("specs/attach-a-spec/spec.md");
  });

  it("is null for a title with nothing sluggable in it", () => {
    // The form uses this to withhold the path preview rather than show
    // `specs//spec.md`, which is not a path the server would ever write.
    expect(specFilePath("!!!")).toBeNull();
  });
});
