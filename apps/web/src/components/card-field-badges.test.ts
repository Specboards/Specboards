import { describe, expect, it } from "vitest";

import { customFieldDisplay } from "./card-field-badges";

/**
 * Date custom fields on a card.
 *
 * The property under test is not really the formatting: it is that the output
 * depends on nothing but the input. Boards render on the server and again in
 * the browser, so a value formatted through the ambient locale can disagree
 * with itself, and React answers a disagreement by discarding the tree and
 * never attaching the page's handlers. A date on a card can therefore make a
 * whole board unclickable, which is why this is pinned rather than assumed.
 */

describe("a date custom field", () => {
  it("renders a fixed English date, not the ambient locale's", () => {
    // "24 Jul 2026" is the same day formatted by a different locale. Either is
    // readable; disagreeing between server and browser is the failure.
    expect(customFieldDisplay("2026-07-24", "date")).toBe("Jul 24, 2026");
  });

  it("does not shift a day at the edges of the calendar", () => {
    // A date-only value has no instant, so nothing here may consult a
    // timezone: 1 January must not become 31 December for a viewer in Auckland
    // or Los Angeles.
    expect(customFieldDisplay("2026-01-01", "date")).toBe("Jan 1, 2026");
    expect(customFieldDisplay("2026-12-31", "date")).toBe("Dec 31, 2026");
  });

  it("leaves an impossible month alone instead of rolling it over", () => {
    // `new Date(2026, 12, 1)` silently means January 2027, which would show a
    // confident wrong answer where the data is simply bad.
    expect(customFieldDisplay("2026-13-01", "date")).toBe("2026-13-01");
    expect(customFieldDisplay("2026-00-10", "date")).toBe("2026-00-10");
  });

  it("passes through anything that is not a date value", () => {
    expect(customFieldDisplay("Q3", "date")).toBe("Q3");
    expect(customFieldDisplay("2026-07-24", "text")).toBe("2026-07-24");
    expect(customFieldDisplay(["a", "b"], "multiselect")).toBe("a, b");
    expect(customFieldDisplay(null, "date")).toBe("");
  });
});
