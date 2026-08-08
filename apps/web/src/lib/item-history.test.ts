import { describe, expect, it } from "vitest";

import {
  describeActor,
  describeChange,
  historyEntries,
  type HistoryContext,
} from "@/lib/item-history";
import type { ItemEvent } from "@/lib/store/types";

/**
 * The change log's job is to be readable by the person who wants to know what
 * happened to their work, which is usually not the person who made the change.
 *
 * Two failure modes are worth more than the rest: leaking the stored ids and
 * status keys into the sentence (the same mistake as telling an author their
 * change is on branch `specboards/spec-x`), and rendering as "undefined" when
 * the row refers to something since deleted, which is exactly when history is
 * most valuable.
 */

const ctx: HistoryContext = {
  workflow: {
    statuses: ["ready", "in_progress"],
    transitions: { ready: ["in_progress"], in_progress: [] },
    // The point of the labels: a workspace that renamed a stage should see its
    // own words in the history, not the stored key.
    labels: { in_progress: "In Progress", ready: "Ready" },
  },
  members: [{ userId: "u1", name: "Jane" }],
  releases: [{ id: "r1", name: "v1.2" }],
  cycles: [{ id: "c1", name: "Sprint 4" }],
};

function event(over: Partial<ItemEvent> = {}): ItemEvent {
  return {
    id: "e1",
    type: "item.field_changed",
    field: "status",
    before: "ready",
    after: "in_progress",
    actorType: "user",
    actorId: "u1",
    actorLabel: "Jane",
    createdAt: "2026-08-08T12:00:00.000Z",
    ...over,
  };
}

describe("describeActor", () => {
  it("names a person", () => {
    expect(describeActor(event())).toEqual({ actor: "Jane", automated: false });
  });

  it("credits the key's owner and still says it was an automation", () => {
    // Both facts matter. The name alone claims they typed it; "automation"
    // alone hides who is accountable for it.
    expect(describeActor(event({ actorType: "api_key", actorLabel: "Release bot" }))).toEqual({
      actor: "Release bot (automation)",
      automated: true,
    });
  });

  it("still renders when the actor was never labelled", () => {
    expect(describeActor(event({ actorLabel: null })).actor).toBe("Someone");
    expect(describeActor(event({ actorType: "sync", actorLabel: null })).actor).toBe(
      "A change in git",
    );
  });
});

describe("describeChange", () => {
  it("uses the workflow's own words for a status move", () => {
    // Not "status: ready -> in_progress".
    expect(describeChange(event(), ctx)).toBe("moved this from Ready to In Progress");
  });

  it("names people, releases and cycles rather than their ids", () => {
    expect(
      describeChange(event({ field: "assigneeId", before: null, after: "u1" }), ctx),
    ).toBe("set the assignee to Jane");
    expect(
      describeChange(event({ field: "releaseId", before: null, after: "r1" }), ctx),
    ).toBe("set the release to v1.2");
    expect(
      describeChange(event({ field: "cycleId", before: "c1", after: null }), ctx),
    ).toBe("cleared the cycle (was Sprint 4)");
  });

  it("stays readable when what it refers to is gone", () => {
    // The case history exists for. An id or "undefined" here would be useless
    // to the person asking what happened.
    expect(
      describeChange(event({ field: "releaseId", before: "deleted", after: null }), ctx),
    ).toBe("cleared the release (was a release that no longer exists)");
    expect(
      describeChange(event({ field: "assigneeId", before: null, after: "gone" }), ctx),
    ).toBe("set the assignee to someone no longer in the workspace");
  });

  it("says what changed about the tags, not that they changed", () => {
    expect(
      describeChange(event({ field: "tags", before: ["a"], after: ["a", "b"] }), ctx),
    ).toBe("added the tag b");
    // Reads as English in both directions, which one shared suffix cannot do.
    expect(
      describeChange(event({ field: "tags", before: ["a", "b"], after: ["b"] }), ctx),
    ).toBe("removed the tag a");
    expect(
      describeChange(event({ field: "tags", before: ["a"], after: ["b"] }), ctx),
    ).toBe("added b and removed a");
    expect(
      describeChange(event({ field: "tags", before: ["a"], after: ["a"] }), ctx),
    ).toBe("changed the tags");
  });

  it("describes long text instead of quoting it", () => {
    // Pasting two paragraphs into a list makes the entries around it
    // unfindable, which costs more than the detail is worth.
    expect(
      describeChange(event({ field: "details", before: "old", after: "new" }), ctx),
    ).toBe("edited the description");
  });

  it("quotes a title, which is short enough to read inline", () => {
    expect(
      describeChange(event({ field: "title", before: "Old", after: "New" }), ctx),
    ).toBe('changed the title from "Old" to "New"');
  });

  it("describes a document change, which names no field at all", () => {
    // These arrive from sync with `field: null`. Falling through to the
    // field-driven wording produces "changed the " with nothing after it,
    // which is what the first version of this did.
    expect(
      describeChange(event({ type: "spec.body_changed", field: null, before: null, after: null }), ctx),
    ).toBe("rewrote the spec");
    expect(
      describeChange(
        event({ type: "spec.moved", field: "path", before: "specs/a.md", after: "specs/b.md" }),
        ctx,
      ),
    ).toBe("moved the spec from specs/a.md to specs/b.md");
  });

  it("falls back to the field name for anything unmapped", () => {
    expect(describeChange(event({ field: "somethingNew", before: 1, after: 2 }), ctx)).toBe(
      "changed the somethingNew from 1 to 2",
    );
  });
});

describe("historyEntries", () => {
  it("keeps the order it is given", () => {
    const rows = historyEntries(
      [event({ id: "a" }), event({ id: "b", field: "title", before: "x", after: "y" })],
      ctx,
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]!.actor).toBe("Jane");
  });
});
