import { describe, expect, it } from "vitest";

import { shippedDateAfterWrite, shippedDateError } from "./releases.js";

const TODAY = "2026-08-31";

describe("shippedDateError", () => {
  it("allows saying nothing, whatever the state", () => {
    expect(shippedDateError(undefined, true)).toBeNull();
    expect(shippedDateError(undefined, false)).toBeNull();
  });

  it("refuses a ship date on a release that has not shipped", () => {
    expect(shippedDateError("2026-07-13", false)).toBe(
      "Only a shipped release can have a ship date.",
    );
  });

  it("treats clearing the date on an unshipped release as a no-op", () => {
    // It is already null. Refusing would fail a multi-field patch for the one
    // field that changes nothing.
    expect(shippedDateError(null, false)).toBeNull();
  });

  it("refuses to clear the date on a shipped release", () => {
    expect(shippedDateError(null, true)).toBe(
      "A shipped release must have a ship date.",
    );
  });

  it("refuses anything that is not a date-only string", () => {
    for (const bad of [
      "2026-7-13",
      "13/07/2026",
      "2026-07-13T00:00:00Z",
      "yesterday",
      "",
    ]) {
      expect(shippedDateError(bad, true)).toBe(
        "shippedDate must be a YYYY-MM-DD date.",
      );
    }
  });

  it("accepts a well-formed date on a shipped release", () => {
    expect(shippedDateError("2026-07-13", true)).toBeNull();
  });
});

describe("shippedDateAfterWrite", () => {
  it("stamps today when a release ships and no date was named", () => {
    expect(
      shippedDateAfterWrite({ shipped: true, previous: null, today: TODAY }),
    ).toBe(TODAY);
  });

  it("takes a named date, including one in the past", () => {
    expect(
      shippedDateAfterWrite({
        shipped: true,
        previous: null,
        explicit: "2026-07-13",
        today: TODAY,
      }),
    ).toBe("2026-07-13");
  });

  it("lets a named date correct one already stored", () => {
    // The reason this exists: a release recorded on the wrong day.
    expect(
      shippedDateAfterWrite({
        shipped: true,
        previous: TODAY,
        explicit: "2026-07-13",
        today: TODAY,
      }),
    ).toBe("2026-07-13");
  });

  it("keeps the existing date when an unrelated edit lands", () => {
    // An edit to the notes must not move the ship date to today.
    expect(
      shippedDateAfterWrite({
        shipped: true,
        previous: "2026-07-13",
        today: TODAY,
      }),
    ).toBe("2026-07-13");
  });

  it("clears the date whenever the release is not shipped", () => {
    for (const previous of [null, "2026-07-13"]) {
      expect(
        shippedDateAfterWrite({ shipped: false, previous, today: TODAY }),
      ).toBeNull();
    }
  });

  it("clears the date on reopen even if one was named", () => {
    // Not reachable through the parsers, which reject that combination, but the
    // rule should not depend on being called correctly.
    expect(
      shippedDateAfterWrite({
        shipped: false,
        previous: "2026-07-13",
        explicit: "2026-07-14",
        today: TODAY,
      }),
    ).toBeNull();
  });
});
