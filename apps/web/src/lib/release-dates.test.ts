import { describe, expect, it } from "vitest";

import { shipDateLabel } from "./release-dates";

/**
 * An item's ship date is derived from its release rather than stored on the
 * item. These pin the derivation, and in particular that an unshipped
 * commitment and a shipped fact never read the same way.
 */
describe("shipDateLabel", () => {
  it("reports a planned release's target date as a commitment", () => {
    expect(shipDateLabel({ targetDate: "2026-09-03", shippedDate: null })).toBe(
      "Ships Sep 3, 2026",
    );
  });

  it("reports a shipped release's actual date as a fact", () => {
    expect(
      shipDateLabel({ targetDate: "2026-09-03", shippedDate: "2026-09-02" }),
    ).toBe("Shipped Sep 2, 2026");
  });

  it("prefers the date that was stamped over the one that was planned", () => {
    // The two disagree whenever a release slips or lands early, and the actual
    // date is the one that answers "when did this ship".
    expect(
      shipDateLabel({ targetDate: "2026-07-01", shippedDate: "2026-08-19" }),
    ).toBe("Shipped Aug 19, 2026");
  });

  it("says nothing for an undated release", () => {
    // Not "no date": spending a line to tell the reader what they can already
    // see is worse than silence, and the same reasoning the relations list
    // uses for unscheduled items.
    expect(shipDateLabel({ targetDate: null, shippedDate: null })).toBeNull();
  });

  it("still reports a release shipped without a target date", () => {
    expect(shipDateLabel({ targetDate: null, shippedDate: "2026-08-30" })).toBe(
      "Shipped Aug 30, 2026",
    );
  });

  it("does not shift a day at the edges of the calendar", () => {
    // A date-only value has no instant, so nothing here may consult a timezone.
    expect(shipDateLabel({ targetDate: "2026-01-01", shippedDate: null })).toBe(
      "Ships Jan 1, 2026",
    );
    expect(shipDateLabel({ targetDate: null, shippedDate: "2026-12-31" })).toBe(
      "Shipped Dec 31, 2026",
    );
  });

  it("leaves a malformed date alone rather than guessing at it", () => {
    expect(shipDateLabel({ targetDate: "2026-13-01", shippedDate: null })).toBe(
      "Ships 2026-13-01",
    );
  });
});
