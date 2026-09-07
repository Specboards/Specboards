import { describe, expect, it } from "vitest";

import { importCounts } from "./import-summary";

/**
 * The numbers the import prompt is allowed to claim.
 *
 * These pin the relationship between `upserted` and `attached`, which is the
 * one a future change to the reconcile loop could quietly break: `upserted` is
 * the total written, `attached` is the subset that found an existing item, and
 * the difference is what the "Create N cards" button actually created.
 */

describe("importCounts", () => {
  it("reports every write as a creation when nothing was attached", () => {
    expect(importCounts({ upserted: 3, attached: 0 })).toEqual({
      created: 3,
      updated: 0,
    });
  });

  it("reports nothing created when every write attached to an existing item", () => {
    // The reported bug: two specs already on the board, one of them changed in
    // git. "Imported 1 spec" was true of the database and false of the button.
    expect(importCounts({ upserted: 1, attached: 1 })).toEqual({
      created: 0,
      updated: 1,
    });
  });

  it("splits a mixed sync into the two numbers", () => {
    expect(importCounts({ upserted: 5, attached: 2 })).toEqual({
      created: 3,
      updated: 2,
    });
  });

  it("reports nothing at all for a no-op sync", () => {
    expect(importCounts({ upserted: 0, attached: 0 })).toEqual({
      created: 0,
      updated: 0,
    });
  });

  it("clamps rather than rendering a negative count", () => {
    // Should not arise, but "Created -1 cards" would be a worse failure than
    // an undercount, and the two counters are incremented at different points.
    expect(importCounts({ upserted: 1, attached: 4 })).toEqual({
      created: 0,
      updated: 4,
    });
  });
});
