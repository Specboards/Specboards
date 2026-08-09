import { describe, expect, it } from "vitest";

import { notificationHeadline } from "@/lib/notification-copy";
import { snippetFor } from "@/lib/review-outcome-notify";
import type { NotificationRecord } from "@/lib/store/types";

/**
 * What the inbox tells an author about their own change.
 *
 * The close case carries the weight. A change that quietly evaporated is worse
 * than one turned down out loud, because the author goes on believing their
 * words are live, so the wording has to say plainly that it did not land and
 * carry the reason where there is one.
 */

function notification(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    type: "mention",
    actorId: "u1",
    actorName: "Jane",
    specId: "s1",
    featureLevel: "work",
    productSlug: "default",
    featureTitle: "Checkout flow",
    commentId: "c1",
    snippet: "…",
    read: false,
    createdAt: "2026-08-08T12:00:00.000Z",
    ...over,
  };
}

describe("notificationHeadline", () => {
  it("names the actor on a mention", () => {
    expect(notificationHeadline(notification())).toEqual({
      actor: "Jane",
      text: "mentioned you",
    });
  });

  it("still renders a mention from someone since deleted", () => {
    expect(notificationHeadline(notification({ actorName: null })).actor).toBe(
      "Someone",
    );
  });

  it("gives an outcome no actor", () => {
    // Naming whoever clicked the button would read as blame on a close, and a
    // merge is a thing that happened rather than a thing done to the reader.
    expect(notificationHeadline(notification({ type: "spec_change_merged" }))).toEqual(
      { actor: null, text: "Your change is live" },
    );
    expect(notificationHeadline(notification({ type: "spec_change_closed" }))).toEqual(
      { actor: null, text: "Your change was closed" },
    );
  });

  it("gives an unknown type a heading rather than nothing", () => {
    // This list grows faster than deployments update; a snippet under a blank
    // heading is worse than a generic one.
    const row = notificationHeadline(notification({ type: "invented_later" }));
    expect(row.text).toBe("updated this");
  });
});

describe("snippetFor", () => {
  it("says a merged change is live", () => {
    expect(snippetFor("merged", "Update the refund policy", null)).toBe(
      "Your change to Update the refund policy is now live.",
    );
  });

  it("says out loud that a closed change did not land", () => {
    expect(snippetFor("closed", "Update the refund policy", null)).toBe(
      "Your change to Update the refund policy was closed without being merged.",
    );
  });

  it("carries the reviewer's reason when there is one", () => {
    const text = snippetFor("closed", "Refunds", "We decided against this for now.");
    expect(text).toContain("was closed without being merged");
    expect(text).toContain("We decided against this for now.");
  });

  it("truncates a long reason instead of flooding the row", () => {
    const text = snippetFor("closed", "Refunds", "x".repeat(600));
    expect(text.length).toBeLessThan(400);
    expect(text).toContain("…");
  });

  it("drops a missing title rather than saying 'your change to null'", () => {
    expect(snippetFor("merged", null, null)).toBe("Your change is now live.");
  });
});
