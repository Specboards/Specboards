import { describe, expect, it } from "vitest";

import { type CascadeRow, planReleaseCascade } from "./release-cascade";

/**
 * What a release change would carry with it.
 *
 * Every case here is one that produced a wrong board rather than an error. The
 * bug this closes was silent by construction: four epics went into v1.0.0,
 * seventeen children stayed out of it, and nothing anywhere said so. The
 * failure mode of the fix is the same shape, so the cases that matter most are
 * the ones about what must *not* move: somebody's deliberate schedule, an item
 * a product release cannot legally hold, and the whole tree when a release is
 * being cleared.
 */

const REL = "rel-target";
const OTHER = "rel-other";
const PROD = "prod-a";

/** A row with sensible defaults, so each test states only what it is about. */
function row(over: Partial<CascadeRow> & { specId: string }): CascadeRow {
  return {
    parentSpecId: null,
    releaseId: null,
    productId: PROD,
    ...over,
  };
}

/** epic -> feature -> task, all unscheduled, all in one product. */
const TREE: CascadeRow[] = [
  row({ specId: "epic" }),
  row({ specId: "feat-1", parentSpecId: "epic" }),
  row({ specId: "feat-2", parentSpecId: "epic" }),
  row({ specId: "task-1", parentSpecId: "feat-1" }),
];

describe("planning a release cascade", () => {
  it("takes the whole subtree, not just the direct children", () => {
    // Stopping at one level is what recreates the bug one level down: an epic's
    // features have children of their own.
    const plan = planReleaseCascade(TREE, "epic", REL, PROD);
    expect(plan.move.sort()).toEqual(["feat-1", "feat-2", "task-1"]);
    expect(plan.depth).toBe(2);
  });

  it("plans nothing for an item with no children", () => {
    // Most items. The prompt must not appear for them at all.
    const plan = planReleaseCascade(TREE, "task-1", REL, PROD);
    expect(plan.move).toEqual([]);
    expect(plan.depth).toBe(0);
  });

  it("leaves a descendant that is already in another release, and says so", () => {
    // The worst available outcome is silently overwriting a deliberate choice,
    // so this one is reported rather than dropped.
    const rows = TREE.map((r) =>
      r.specId === "feat-2" ? { ...r, releaseId: OTHER } : r,
    );
    const plan = planReleaseCascade(rows, "epic", REL, PROD);
    expect(plan.move.sort()).toEqual(["feat-1", "task-1"]);
    expect(plan.skipped).toEqual(["feat-2"]);
  });

  it("still reaches the children of a descendant it left alone", () => {
    // Being in another release does not seal off the work beneath it: the
    // grandchild is unscheduled and still needs the release.
    const rows = TREE.map((r) =>
      r.specId === "feat-1" ? { ...r, releaseId: OTHER } : r,
    );
    const plan = planReleaseCascade(rows, "epic", REL, PROD);
    expect(plan.skipped).toEqual(["feat-1"]);
    expect(plan.move).toContain("task-1");
  });

  it("does not re-write a descendant already in the target release", () => {
    const rows = TREE.map((r) =>
      r.specId === "feat-2" ? { ...r, releaseId: REL } : r,
    );
    const plan = planReleaseCascade(rows, "epic", REL, PROD);
    expect(plan.move).not.toContain("feat-2");
    expect(plan.skipped).not.toContain("feat-2");
  });

  it("refuses a descendant whose product the release does not belong to", () => {
    // A product release only takes items from its own product, so including
    // this one would fail partway and leave the cascade half applied.
    const rows = TREE.map((r) =>
      r.specId === "feat-2" ? { ...r, productId: "prod-b" } : r,
    );
    const plan = planReleaseCascade(rows, "epic", REL, PROD);
    expect(plan.ineligible).toEqual(["feat-2"]);
    expect(plan.move).not.toContain("feat-2");
  });

  it("lets a portfolio release take items from any product", () => {
    const rows = TREE.map((r) =>
      r.specId === "feat-2" ? { ...r, productId: "prod-b" } : r,
    );
    const plan = planReleaseCascade(rows, "epic", REL, null);
    expect(plan.ineligible).toEqual([]);
    expect(plan.move.sort()).toEqual(["feat-1", "feat-2", "task-1"]);
  });

  it("cascades nothing when the release is being cleared", () => {
    // Not a special case: every scheduled child is "in a different release"
    // from no release at all. The consequence is the one that matters, so it is
    // pinned here rather than left to be rediscovered: unsetting a parent's
    // release can never mass-unschedule the work underneath it.
    const rows = TREE.map((r) =>
      r.parentSpecId ? { ...r, releaseId: OTHER } : r,
    );
    const plan = planReleaseCascade(rows, "epic", null, null);
    expect(plan.move).toEqual([]);
    expect(plan.skipped.sort()).toEqual(["feat-1", "feat-2", "task-1"]);
  });

  it("counts depth from the deepest thing that actually moves", () => {
    // The prompt says "across N levels", so the number has to describe the
    // writes rather than the shape of the tree.
    const rows = TREE.map((r) =>
      r.specId === "task-1" ? { ...r, releaseId: OTHER } : r,
    );
    const plan = planReleaseCascade(rows, "epic", REL, PROD);
    expect(plan.move.sort()).toEqual(["feat-1", "feat-2"]);
    expect(plan.depth).toBe(1);
  });

  it("ignores a subtree the caller cannot read", () => {
    // Rows are the readable set, so a filtered-out parent takes its children
    // with it. The plan must never count a row the prompt cannot name.
    const rows = TREE.filter((r) => r.specId !== "feat-1");
    const plan = planReleaseCascade(rows, "epic", REL, PROD);
    expect(plan.move).toEqual(["feat-2"]);
  });

  it("terminates on a parent cycle instead of walking it forever", () => {
    // Unreachable through the API, which refuses a cycle-creating parent
    // change. The guard bounds the walk if rows are ever written around it.
    const rows: CascadeRow[] = [
      row({ specId: "epic" }),
      row({ specId: "a", parentSpecId: "epic" }),
      row({ specId: "b", parentSpecId: "a" }),
      row({ specId: "a2", parentSpecId: "b", ...{} }),
    ];
    // Close the loop: b's child points back at a.
    const looped = rows.map((r) =>
      r.specId === "a2" ? { ...r, specId: "a", parentSpecId: "b" } : r,
    );
    const plan = planReleaseCascade(looped, "epic", REL, PROD);
    expect(plan.move.sort()).toEqual(["a", "b"]);
  });
});
