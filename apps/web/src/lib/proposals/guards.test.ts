import { describe, expect, it } from "vitest";

import { ProposalStaleError, ProposalTooLongError } from "./errors";
import {
  assertMetadataNotStale,
  assertNotStale,
  assertSentWhole,
  metadataVersion,
} from "./guards";

/**
 * The checks that decide whether a proposal is still applicable.
 *
 * The interesting cases are all about what should NOT trip them. A guard that
 * refuses too readily is worse than no guard: it turns a review queue into a
 * list of things that used to be applicable, and people stop opening it.
 */

describe("a document that could not be sent whole", () => {
  it("lets a normal one through", () => {
    expect(() => assertSentWhole(true, "item")).not.toThrow();
  });

  it("refuses a rewrite that would truncate the document", () => {
    expect(() => assertSentWhole(false, "item")).toThrow(ProposalTooLongError);
    expect(() => assertSentWhole(false, "release")).toThrow(ProposalTooLongError);
  });
});

describe("a document that moved after drafting", () => {
  it("lets a row that predates the guard through", () => {
    // A null base means the row was drafted before the guard existed.
    // Refusing those would break every draft already sitting on a card, to
    // protect against a race that has probably not happened.
    expect(() => assertNotStale(null, "anything at all", "item")).not.toThrow();
  });

  it("refuses when the base does not match, and shows what is there now", () => {
    try {
      assertNotStale("a-hash-of-something-else", "newer text", "item");
      expect.unreachable("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ProposalStaleError);
      // The reviewer clicked Apply on a diff; the useful next step is seeing
      // what it should have been a diff against.
      expect((err as ProposalStaleError).currentBody).toBe("newer text");
    }
  });

  it("names the right subject, so the message is not about the wrong thing", () => {
    const forItem = catchMessage(() =>
      assertNotStale("stale", "x", "item"),
    );
    const forRelease = catchMessage(() =>
      assertNotStale("stale", "x", "release"),
    );
    expect(forItem).toMatch(/description/i);
    expect(forRelease).toMatch(/release notes/i);
  });
});

function catchMessage(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("a metadata fingerprint", () => {
  const item = {
    status: "defining",
    tags: ["api", "urgent"],
    assigneeId: "u-1",
    title: "Something",
  };

  it("covers only the fields the change set touches", () => {
    // A proposal to change the tags should not go stale because somebody else
    // changed the assignee. That is two people not colliding.
    const before = metadataVersion(item, ["tags"]);
    const after = metadataVersion({ ...item, assigneeId: "u-2" }, ["tags"]);
    expect(after).toBe(before);
  });

  it("changes when a covered field changes", () => {
    const before = metadataVersion(item, ["status"]);
    const after = metadataVersion({ ...item, status: "done" }, ["status"]);
    expect(after).not.toBe(before);
  });

  it("does not care what order the tags came back in", () => {
    // Without this every metadata proposal on the item would be refused as
    // stale forever, on a read that returned the same three tags.
    const a = metadataVersion(item, ["tags"]);
    const b = metadataVersion({ ...item, tags: ["urgent", "api"] }, ["tags"]);
    expect(b).toBe(a);
  });

  it("does not care what order custom field keys came back in", () => {
    const a = metadataVersion({ customFields: { x: 1, y: 2 } }, ["customFields"]);
    const b = metadataVersion({ customFields: { y: 2, x: 1 } }, ["customFields"]);
    expect(b).toBe(a);
  });

  it("treats a missing field and a null field the same", () => {
    const a = metadataVersion({}, ["assigneeId"]);
    const b = metadataVersion({ assigneeId: null }, ["assigneeId"]);
    expect(b).toBe(a);
  });
});

describe("applying a metadata change set after the item moved", () => {
  const item = { status: "defining", tags: ["api"] };

  it("lets an unmoved item through", () => {
    const base = metadataVersion(item, ["status"]);
    expect(() => assertMetadataNotStale(base, item, ["status"])).not.toThrow();
  });

  it("lets a row that predates the guard through", () => {
    expect(() => assertMetadataNotStale(null, item, ["status"])).not.toThrow();
  });

  it("refuses to walk the board backwards", () => {
    // The case this exists for: an agent proposed `ready`, nobody looked at
    // the queue for two days, and the work shipped in the meantime.
    const base = metadataVersion(item, ["status"]);
    const shipped = { ...item, status: "done" };
    try {
      assertMetadataNotStale(base, shipped, ["status"]);
      expect.unreachable("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ProposalStaleError);
      expect((err as ProposalStaleError).currentBody).toContain("done");
    }
  });

  it("ignores a change to a field the proposal does not touch", () => {
    const base = metadataVersion(item, ["status"]);
    const retagged = { ...item, tags: ["api", "ux"] };
    expect(() => assertMetadataNotStale(base, retagged, ["status"])).not.toThrow();
  });
});
