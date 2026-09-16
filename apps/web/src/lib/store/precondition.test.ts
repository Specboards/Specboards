import { describe, expect, it } from "vitest";

import {
  StaleWriteError,
  assertUnchanged,
  fingerprintOf,
  stable,
} from "./precondition";

/**
 * The fingerprint a write carries so it can refuse instead of overwriting.
 *
 * The cases below are the ways it goes wrong in practice, and all but the
 * first fail in the same direction: not a wrong answer, but a fingerprint
 * that stops matching itself, which refuses every write forever. That is why
 * order independence and the null/undefined collapse are tested as hard as
 * the detection is.
 */

describe("stable", () => {
  it("does not care what order an object's keys arrived in", () => {
    expect(stable({ b: 1, a: 2 })).toEqual(stable({ a: 2, b: 1 }));
  });

  it("does not care what order a list arrived in", () => {
    // Tags are the case that forces it: the same three tags coming back in a
    // different order between two reads would read as a change.
    expect(stable(["ux", "api", "urgent"])).toEqual(
      stable(["urgent", "ux", "api"]),
    );
  });

  it("treats an absent field and a null one as the same fact", () => {
    // A column missing from a projection and one that is SQL NULL mean the
    // same thing here, and a fingerprint that told them apart would refuse
    // writes depending on which read produced it.
    expect(stable(undefined)).toBe(null);
    expect(stable(null)).toBe(null);
  });

  it("reduces a date to something comparable", () => {
    expect(stable(new Date("2026-09-15T10:00:00Z"))).toBe(
      "2026-09-15T10:00:00.000Z",
    );
  });

  it("sorts nested structures too", () => {
    expect(stable({ tags: ["b", "a"], meta: { y: 1, x: 2 } })).toEqual(
      stable({ meta: { x: 2, y: 1 }, tags: ["a", "b"] }),
    );
  });
});

describe("fingerprintOf", () => {
  const row = { status: "ready", tags: ["api"], assigneeId: null };

  it("is stable across reads of the same values", () => {
    expect(fingerprintOf(row, ["status"])).toBe(
      fingerprintOf({ ...row, tags: ["ux"] }, ["status"]),
    );
  });

  it("changes when a watched field changes", () => {
    expect(fingerprintOf(row, ["status"])).not.toBe(
      fingerprintOf({ ...row, status: "done" }, ["status"]),
    );
  });

  it("ignores a field nobody is writing", () => {
    // The narrowness is the point. Watching the whole row would mean a write
    // that sets a tag refused because somebody else set the assignee.
    expect(fingerprintOf(row, ["tags"])).toBe(
      fingerprintOf({ ...row, assigneeId: "u-1" }, ["tags"]),
    );
  });

  it("does not care what order the field list arrived in", () => {
    expect(fingerprintOf(row, ["status", "tags"])).toBe(
      fingerprintOf(row, ["tags", "status"]),
    );
  });

  it("distinguishes the same values under different field names", () => {
    // Two rows agreeing on `status` are not interchangeable with two rows
    // agreeing on `title`, even when the values match.
    expect(fingerprintOf({ a: "x" }, ["a"])).not.toBe(
      fingerprintOf({ b: "x" }, ["b"]),
    );
  });
});

describe("assertUnchanged", () => {
  const row = { status: "ready", tags: ["api"] };

  it("passes when the values still match", () => {
    const taken = fingerprintOf(row, ["status"]);
    expect(() => assertUnchanged(taken, row, ["status"], "item")).not.toThrow();
  });

  it("refuses when they moved", () => {
    const taken = fingerprintOf(row, ["status"]);
    expect(() =>
      assertUnchanged(taken, { ...row, status: "done" }, ["status"], "item"),
    ).toThrow(StaleWriteError);
  });

  it("names the subject and says nothing was written", () => {
    const taken = fingerprintOf(row, ["status"]);
    try {
      assertUnchanged(taken, { ...row, status: "done" }, ["status"], "release");
      expect.unreachable("should have refused");
    } catch (err) {
      expect((err as Error).message).toContain("release");
      expect((err as Error).message).toContain("Nothing was written");
      expect((err as StaleWriteError).fields).toEqual(["status"]);
    }
  });

  it("does not check at all when no fingerprint was asked for", () => {
    // Every ordinary edit takes this path. A person acting on what is in
    // front of them wants last write wins, not a conflict dialog.
    expect(() =>
      assertUnchanged(undefined, { status: "anything" }, ["status"], "item"),
    ).not.toThrow();
  });
});
