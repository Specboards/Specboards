import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_EVENT_TYPES,
} from "@/lib/notifications/catalog";
import {
  resolveChannelsPerUser,
  resolveUserMatrix,
  resolveWorkspaceMatrix,
  type MatrixRow,
} from "@/lib/notifications/matrix";

/**
 * The fold behind "inherited".
 *
 * The cases worth pinning are the ones where the layers disagree, because
 * those are the ones the storage shape exists to get right: a live default has
 * to move somebody who has not overridden a row and leave somebody who has.
 */

function cell(rows: MatrixRow[], type: string, channel: "in_app" | "email") {
  const row = rows.find((r) => r.type === type);
  if (!row) throw new Error(`no row for ${type}`);
  return row.channels[channel];
}

describe("resolveWorkspaceMatrix", () => {
  it("is the catalog when the workspace has set nothing", () => {
    const rows = resolveWorkspaceMatrix([]);
    expect(rows).toHaveLength(NOTIFICATION_EVENT_TYPES.length);
    for (const row of rows) {
      expect(row.channels.in_app).toEqual({
        enabled: NOTIFICATION_DEFAULTS[row.type].in_app,
        source: "catalog",
      });
    }
  });

  it("takes the workspace's value where it has one, and says so", () => {
    const rows = resolveWorkspaceMatrix([
      { eventType: "item.created", channel: "in_app", enabled: false },
    ]);
    expect(cell(rows, "item.created", "in_app")).toEqual({
      enabled: false,
      source: "workspace",
    });
    // The neighbouring cell is untouched, which is what makes a default a
    // per-cell thing rather than a per-row one.
    expect(cell(rows, "item.created", "email").source).toBe("catalog");
  });

  it("ignores a stored row for an event type the catalog no longer has", () => {
    const rows = resolveWorkspaceMatrix([
      { eventType: "item.retired", channel: "in_app", enabled: true },
    ]);
    expect(rows.some((r) => (r.type as string) === "item.retired")).toBe(false);
  });
});

describe("resolveUserMatrix", () => {
  it("inherits the workspace value, tagged as the workspace's", () => {
    const rows = resolveUserMatrix(
      [{ eventType: "item.status_changed", channel: "in_app", enabled: false }],
      [],
    );
    expect(cell(rows, "item.status_changed", "in_app")).toEqual({
      enabled: false,
      source: "workspace",
    });
  });

  it("lets a user turn back on what the workspace turned off", () => {
    const rows = resolveUserMatrix(
      [{ eventType: "item.status_changed", channel: "in_app", enabled: false }],
      [{ eventType: "item.status_changed", channel: "in_app", enabled: true }],
    );
    expect(cell(rows, "item.status_changed", "in_app")).toEqual({
      enabled: true,
      source: "user",
    });
  });

  it("reads a user override that agrees with the value under it as the user's", () => {
    // Not a cosmetic distinction. This cell must not move when the workspace
    // default changes, and "who set it" is the only thing that says so.
    const rows = resolveUserMatrix(
      [{ eventType: "comment.created", channel: "in_app", enabled: true }],
      [{ eventType: "comment.created", channel: "in_app", enabled: true }],
    );
    expect(cell(rows, "comment.created", "in_app").source).toBe("user");
  });

  it("moves an un-overridden row when the workspace default changes", () => {
    const before = resolveUserMatrix([], []);
    const after = resolveUserMatrix(
      [{ eventType: "item.assigned", channel: "in_app", enabled: false }],
      [],
    );
    expect(cell(before, "item.assigned", "in_app").enabled).toBe(true);
    expect(cell(after, "item.assigned", "in_app").enabled).toBe(false);
  });

  it("leaves an overridden row where the user put it when the default changes", () => {
    const rows = resolveUserMatrix(
      [{ eventType: "item.assigned", channel: "in_app", enabled: false }],
      [{ eventType: "item.assigned", channel: "in_app", enabled: true }],
    );
    expect(cell(rows, "item.assigned", "in_app").enabled).toBe(true);
  });
});

describe("resolveChannelsPerUser", () => {
  it("answers for every user asked about, override or not", () => {
    const decisions = resolveChannelsPerUser(
      ["alice", "bob"],
      "item.assigned",
      [],
      [
        {
          userId: "alice",
          eventType: "item.assigned",
          channel: "email",
          enabled: false,
        },
      ],
    );
    expect(decisions.get("alice")).toEqual({ in_app: true, email: false });
    expect(decisions.get("bob")).toEqual(
      NOTIFICATION_DEFAULTS["item.assigned"],
    );
  });

  it("layers a user's override over the workspace's, per channel", () => {
    const decisions = resolveChannelsPerUser(
      ["alice"],
      "comment.mentioned",
      [
        { eventType: "comment.mentioned", channel: "in_app", enabled: false },
        { eventType: "comment.mentioned", channel: "email", enabled: false },
      ],
      [
        {
          userId: "alice",
          eventType: "comment.mentioned",
          channel: "in_app",
          enabled: true,
        },
      ],
    );
    // Her own choice on one channel, the workspace's on the other.
    expect(decisions.get("alice")).toEqual({ in_app: true, email: false });
  });

  it("does not let one user's override reach another", () => {
    const decisions = resolveChannelsPerUser(
      ["alice", "bob"],
      "item.created",
      [],
      [
        {
          userId: "alice",
          eventType: "item.created",
          channel: "in_app",
          enabled: false,
        },
      ],
    );
    expect(decisions.get("alice")?.in_app).toBe(false);
    expect(decisions.get("bob")?.in_app).toBe(true);
  });

  it("ignores an override for a different event type", () => {
    const decisions = resolveChannelsPerUser(
      ["alice"],
      "item.assigned",
      [],
      [
        {
          userId: "alice",
          eventType: "item.created",
          channel: "in_app",
          enabled: false,
        },
      ],
    );
    expect(decisions.get("alice")?.in_app).toBe(true);
  });
});
