import { describe, expect, it } from "vitest";

import { groupNotifications } from "@/lib/notification-groups";
import type { NotificationRecord } from "@/lib/store/types";

/**
 * Ten changes to one item reading as one block.
 *
 * The ordering rule is the part that would break quietly: the inbox arrives
 * newest first, and a group has to sit where its newest row was, or an item
 * somebody touched a minute ago sinks to wherever its oldest notice lives.
 */

let seq = 0;
function row(over: Partial<NotificationRecord> = {}): NotificationRecord {
  seq += 1;
  return {
    id: `n${seq}`,
    type: "item.status_changed",
    actorId: "u1",
    actorName: "Jane",
    specId: "spec-1",
    featureLevel: "work",
    productSlug: "default",
    productName: "Default",
    featureTitle: "Checkout flow",
    commentId: null,
    snippet: "moved",
    read: false,
    createdAt: `2026-09-0${(seq % 9) + 1}T12:00:00.000Z`,
    ...over,
  };
}

describe("groupNotifications", () => {
  it("collapses several notices about one item into one block", () => {
    const groups = groupNotifications([row(), row(), row()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(3);
    expect(groups[0]!.featureTitle).toBe("Checkout flow");
  });

  it("keeps different items apart", () => {
    const groups = groupNotifications([
      row({ specId: "a", featureTitle: "A" }),
      row({ specId: "b", featureTitle: "B" }),
      row({ specId: "a", featureTitle: "A" }),
    ]);
    expect(groups.map((g) => g.specId)).toEqual(["a", "b"]);
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("puts a group where its newest row was", () => {
    // The input is newest first. An item touched a minute ago must stay at the
    // top even if it also has the oldest notice in the page.
    const groups = groupNotifications([
      row({ specId: "recent", createdAt: "2026-09-07T12:00:00.000Z" }),
      row({ specId: "older", createdAt: "2026-09-06T12:00:00.000Z" }),
      row({ specId: "recent", createdAt: "2026-09-01T12:00:00.000Z" }),
    ]);
    expect(groups.map((g) => g.specId)).toEqual(["recent", "older"]);
    expect(groups[0]!.newestAt).toBe("2026-09-07T12:00:00.000Z");
  });

  it("counts the unread in each group, so a block can say what is new", () => {
    const groups = groupNotifications([
      row({ specId: "a", read: false }),
      row({ specId: "a", read: true }),
      row({ specId: "a", read: false }),
      row({ specId: "b", read: true }),
    ]);
    expect(groups[0]!.unreadCount).toBe(2);
    expect(groups[1]!.unreadCount).toBe(0);
  });

  it("returns nothing for an empty inbox", () => {
    expect(groupNotifications([])).toEqual([]);
  });
});
