import { describe, expect, it } from "vitest";

import { conflictingSections, merge3 } from "./merge.js";

/** A spec body with three sections, the shape the real cases have. */
function spec(problem: string, design: string, acceptance: string): string {
  return [
    "# Refunds",
    "",
    "## Problem",
    "",
    problem,
    "",
    "## Design",
    "",
    design,
    "",
    "## Acceptance",
    "",
    acceptance,
  ].join("\n");
}

const BASE = spec("Refunds take too long.", "TBD.", "A refund completes.");

describe("merge3", () => {
  it("merges edits to different sections, which is the whole point", () => {
    // The product manager rewrites the problem; the designer fills in design.
    // Neither should have to redo their work because the other saved first.
    const mine = spec("Refunds take eleven days.", "TBD.", "A refund completes.");
    const theirs = spec(
      "Refunds take too long.",
      "One screen, no confirmation step.",
      "A refund completes.",
    );

    const result = merge3(BASE, mine, theirs);

    expect(result.clean).toBe(true);
    expect(result.merged).toContain("Refunds take eleven days.");
    expect(result.merged).toContain("One screen, no confirmation step.");
    expect(result.merged).toContain("A refund completes.");
  });

  it("keeps one side's edit when the other changed nothing", () => {
    const mine = spec("Rewritten.", "TBD.", "A refund completes.");
    expect(merge3(BASE, mine, BASE)).toMatchObject({
      clean: true,
      merged: mine,
    });
    expect(merge3(BASE, BASE, mine)).toMatchObject({
      clean: true,
      merged: mine,
    });
  });

  it("emits an identical edit once rather than twice", () => {
    // Two people fixing the same typo is a merge, not a duplication.
    const both = spec("Refunds take too long today.", "TBD.", "A refund completes.");
    const result = merge3(BASE, both, both);
    expect(result.clean).toBe(true);
    expect(result.merged).toBe(both);
  });

  it("reports a conflict when both rewrote the same lines", () => {
    const mine = spec("Refunds take eleven days.", "TBD.", "A refund completes.");
    const theirs = spec("Refunds are slow.", "TBD.", "A refund completes.");

    const result = merge3(BASE, mine, theirs);

    expect(result.clean).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.mine).toContain("Refunds take eleven days.");
    expect(result.conflicts[0]!.theirs).toContain("Refunds are slow.");
  });

  it("merges an addition at the end with an edit at the start", () => {
    const mine = `${BASE}\n\n## Rollout\n\nBehind a flag.`;
    const theirs = spec("Refunds are slow.", "TBD.", "A refund completes.");

    const result = merge3(BASE, mine, theirs);

    expect(result.clean).toBe(true);
    expect(result.merged).toContain("Behind a flag.");
    expect(result.merged).toContain("Refunds are slow.");
  });

  it("conflicts when both appended different endings", () => {
    const result = merge3(BASE, `${BASE}\n\nMine.`, `${BASE}\n\nTheirs.`);
    expect(result.clean).toBe(false);
  });

  it("handles one side deleting a section the other left alone", () => {
    const mine = ["# Refunds", "", "## Problem", "", "Refunds take too long."].join(
      "\n",
    );
    const theirs = spec("Refunds take too long.", "One screen.", "A refund completes.");

    // Deleting text the other side edited is a genuine disagreement about
    // whether it should exist, so it is reported rather than resolved.
    expect(merge3(BASE, mine, theirs).clean).toBe(false);
    // Deleting text nobody else touched is not.
    expect(merge3(BASE, mine, BASE)).toMatchObject({ clean: true, merged: mine });
  });

  it("handles empty documents at either end", () => {
    expect(merge3("", "", "")).toMatchObject({ clean: true, merged: "" });
    expect(merge3("", "written", "")).toMatchObject({
      clean: true,
      merged: "written",
    });
    expect(merge3("gone", "", "gone")).toMatchObject({ clean: true, merged: "" });
  });

  it("reaches the same verdict whichever side is called mine", () => {
    // Whether a save merges must not depend on who happened to press save
    // first, or the same pair of edits would succeed or fail by luck.
    const a = spec("Mine.", "TBD.", "A refund completes.");
    const b = spec("Refunds take too long.", "Theirs.", "A refund completes.");
    const c = spec("Theirs.", "TBD.", "A refund completes.");
    expect(merge3(BASE, a, b).clean).toBe(merge3(BASE, b, a).clean);
    expect(merge3(BASE, a, c).clean).toBe(merge3(BASE, c, a).clean);
    expect(merge3(BASE, a, b).merged).toBe(merge3(BASE, b, a).merged);
  });

  it("survives a heading rename, which section-based merging would not", () => {
    // Renaming "## Design" reads as a delete plus an add to anything keyed on
    // headings. On lines it is one changed line, and an edit elsewhere merges.
    const mine = BASE.replace("## Design", "## Design notes");
    const theirs = spec("Refunds take eleven days.", "TBD.", "A refund completes.");

    const result = merge3(BASE, mine, theirs);

    expect(result.clean).toBe(true);
    expect(result.merged).toContain("## Design notes");
    expect(result.merged).toContain("Refunds take eleven days.");
  });
});

describe("conflictingSections", () => {
  it("names the section both sides edited", () => {
    const mine = spec("Mine.", "TBD.", "A refund completes.");
    const theirs = spec("Theirs.", "TBD.", "A refund completes.");
    expect(conflictingSections(BASE, mine, theirs)).toEqual(["Problem"]);
  });

  it("names nothing when the edits are in different sections", () => {
    const mine = spec("Mine.", "TBD.", "A refund completes.");
    const theirs = spec("Refunds take too long.", "Theirs.", "A refund completes.");
    expect(conflictingSections(BASE, mine, theirs)).toEqual([]);
  });

  it("reports the opening as the empty heading, for callers to name", () => {
    const mine = BASE.replace("# Refunds", "# Refunds and credits");
    const theirs = BASE.replace("# Refunds", "# Refund handling");
    expect(conflictingSections(BASE, mine, theirs)).toEqual([""]);
  });

  it("lists every shared section when several clash", () => {
    const mine = spec("Mine.", "Mine.", "A refund completes.");
    const theirs = spec("Theirs.", "Theirs.", "A refund completes.");
    expect(conflictingSections(BASE, mine, theirs).sort()).toEqual([
      "Design",
      "Problem",
    ]);
  });
});
