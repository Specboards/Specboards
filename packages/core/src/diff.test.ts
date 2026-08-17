import { describe, expect, it } from "vitest";

import { diffHunks, diffLines, type DiffLine } from "./diff.js";

/**
 * The diff a person reads before deciding whether to accept an assistant's
 * edit. What is tested here is what a reader would notice if it were wrong:
 * that removals are shown at all (the failure the feature exists to prevent is
 * text disappearing without anyone seeing it go), that the surviving text is
 * recognised as surviving rather than re-listed as a rewrite, and that a change
 * in one place does not drag the rest of the document into the view.
 */

/** Compact rendering, so an expectation reads like the diff it describes. */
const render = (lines: DiffLine[]) =>
  lines.map((l) => `${l.kind === "same" ? " " : l.kind === "add" ? "+" : "-"}${l.text}`);

describe("diffing two versions of a document", () => {
  it("reports an unchanged document as entirely unchanged", () => {
    const doc = "one\ntwo\nthree";
    expect(diffLines(doc, doc).every((l) => l.kind === "same")).toBe(true);
  });

  it("shows what was removed, not only what arrived", () => {
    // The whole point of a diff over a block of new text. An accept that
    // silently drops a paragraph is the failure this view exists to catch.
    const out = render(diffLines("keep\ndrop me\nkeep too", "keep\nkeep too"));
    expect(out).toEqual([" keep", "-drop me", " keep too"]);
  });

  it("keeps a pure insertion from being read as a rewrite", () => {
    const out = render(diffLines("a\nb", "a\nnew\nb"));
    expect(out).toEqual([" a", "+new", " b"]);
  });

  it("puts the old line above the new one that replaces it", () => {
    // Convention, and what a reader's eye expects. Emitting the addition first
    // is not wrong so much as unreadable.
    const out = render(diffLines("before", "after"));
    expect(out).toEqual(["-before", "+after"]);
  });

  it("treats an empty document as no lines rather than one blank one", () => {
    expect(render(diffLines("", "hello"))).toEqual(["+hello"]);
    expect(render(diffLines("hello", ""))).toEqual(["-hello"]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("recognises moved-around text it has seen before", () => {
    // A reordering is a real edit and must not be reported as unchanged, but
    // the lines it keeps must not all be reported as rewritten either.
    const out = diffLines("a\nb\nc", "c\na\nb");
    expect(out.filter((l) => l.kind === "same").map((l) => l.text)).toEqual([
      "a",
      "b",
    ]);
    expect(out.filter((l) => l.kind === "add")).toHaveLength(1);
    expect(out.filter((l) => l.kind === "remove")).toHaveLength(1);
  });

  it("reconstructs the new document from what it kept and added", () => {
    // The invariant that makes the view trustworthy: read only the lines a
    // reader is told will survive, and you have exactly the proposed document.
    const before = "# Title\n\nOne\nTwo\nThree\n";
    const after = "# Title\n\nOne\nTwo point five\nThree\nFour\n";
    const rebuilt = diffLines(before, after)
      .filter((l) => l.kind !== "remove")
      .map((l) => l.text)
      .join("\n");
    expect(rebuilt).toBe(after);
  });
});

describe("grouping a diff into the regions worth showing", () => {
  const doc = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

  it("shows nothing when nothing changed", () => {
    expect(diffHunks(diffLines(doc(20), doc(20)))).toEqual([]);
  });

  it("does not drag the whole document in for one edit", () => {
    // A proposal that rewrites one heading in a long spec is mostly unchanged
    // text. Rendering all of it buries the part that matters.
    const before = doc(40);
    const after = before.replace("line 20", "line twenty");
    const lines = diffLines(before, after);
    const [hunk, ...rest] = diffHunks(lines, 3);
    expect(rest).toEqual([]);
    expect(hunk!.end - hunk!.start).toBeLessThan(12);
    expect(hunk!.added).toBe(1);
    expect(hunk!.removed).toBe(1);
  });

  it("keeps two distant edits apart", () => {
    const before = doc(60);
    const after = before.replace("line 5", "five").replace("line 50", "fifty");
    expect(diffHunks(diffLines(before, after), 3)).toHaveLength(2);
  });

  it("merges two edits close enough that splitting them shows no gap", () => {
    // Two boxes with nothing between them is worse than one box: the reader
    // pays for a boundary that separates nothing.
    const before = doc(30);
    const after = before.replace("line 10", "ten").replace("line 13", "thirteen");
    expect(diffHunks(diffLines(before, after), 3)).toHaveLength(1);
  });

  it("never overlaps or reorders its regions", () => {
    // Rendering walks the hunks in order and slices the diff by them, so an
    // overlap would print the same lines twice.
    const before = doc(80);
    const after = before
      .replace("line 4", "four")
      .replace("line 30", "thirty")
      .replace("line 70", "seventy");
    const hunks = diffHunks(diffLines(before, after), 3);
    for (const [i, h] of hunks.entries()) {
      expect(h.start).toBeLessThan(h.end);
      if (i > 0) expect(h.start).toBeGreaterThanOrEqual(hunks[i - 1]!.end);
    }
  });

  it("counts every changed line in some hunk exactly once", () => {
    // The counts drive "3 added, 1 removed" in the header. A changed line that
    // falls between hunks would be invisible in the view and uncounted in the
    // summary, which is the one combination nobody would notice.
    const lines = diffLines(doc(50), doc(50).replace("line 25", "x\ny\nz"));
    const hunks = diffHunks(lines, 3);
    const changed = lines.filter((l) => l.kind !== "same").length;
    expect(hunks.reduce((n, h) => n + h.added + h.removed, 0)).toBe(changed);
  });
});
