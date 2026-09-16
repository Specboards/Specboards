import { describe, expect, it } from "vitest";

import { architectureGapMessage, choosePages } from "./architecture-context";

/**
 * Which architecture pages a review is given, and which it is not.
 *
 * The rule is the whole feature. A review that read an arbitrary slice of a
 * team's architecture and reported confidently on it is worse than no review,
 * because it reads exactly like one that checked everything. So what gets
 * chosen has to be predictable by a person looking at the area, which means
 * pinned here rather than observed by watching what a model was sent.
 *
 * Sizes below are given in whole thousands to keep the arithmetic against the
 * 6,000 character budget legible.
 */

const K = 1_000;

function page(path: string, chars = 100) {
  return { path, chars };
}

describe("choosePages", () => {
  it("takes the shallow pages first, whatever order they arrive in", () => {
    // Breadth-first is the rule, and it is a rule rather than a heuristic: the
    // pages a team put at the top of its area are its overviews, and depth is
    // reached only when there is room.
    const chosen = choosePages([
      page("Events/Bus/Retries"),
      page("Payments"),
      page("Events/Bus"),
      page("Architecture"),
    ]);
    expect(chosen).toEqual([
      "Architecture",
      "Payments",
      "Events/Bus",
      "Events/Bus/Retries",
    ]);
  });

  it("orders pages at the same depth by path, so two runs agree", () => {
    const chosen = choosePages([page("Zebra"), page("Apple"), page("Mango")]);
    expect(chosen).toEqual(["Apple", "Mango", "Zebra"]);
  });

  it("stops at eight pages, because each one is a request in a GitHub area", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      page(`Page-${String(i).padStart(2, "0")}`),
    );
    expect(choosePages(many)).toHaveLength(8);
  });

  it("stops when the characters run out, not only when the count does", () => {
    // Four pages, well under the count limit, and over the character budget.
    const chosen = choosePages([
      page("A", 2 * K),
      page("B", 2 * K),
      page("C", 2 * K),
      page("D", 2 * K),
    ]);
    expect(chosen).toEqual(["A", "B", "C"]);
  });

  it("skips a page too large to fit and keeps going", () => {
    // The failure this prevents: one enormous document at the top of an area
    // hiding everything below it, leaving the reader with an outline full of
    // pages and a review that mentions none of them. The outline still names
    // the page that was skipped, so nothing disappears silently.
    const chosen = choosePages([
      page("Huge", 9 * K),
      page("Small", 1 * K),
      page("Also-small", 1 * K),
    ]);
    expect(chosen).toEqual(["Also-small", "Small"]);
  });

  it("never cuts a page in half", () => {
    // Half a page of architecture is the arbitrary prefix the whole rule exists
    // to avoid, in miniature. A page is sent whole or not at all, so the budget
    // is spent in whole pages and what is left over is simply left over.
    const chosen = choosePages([page("First", 5 * K), page("Second", 5 * K)]);
    expect(chosen).toEqual(["First"]);
  });

  it("changes nothing about an area that comfortably fits", () => {
    const all = [page("One"), page("Two"), page("Three")];
    expect(choosePages(all)).toHaveLength(3);
  });
});

describe("architectureGapMessage", () => {
  it("tells each of the three cases apart", () => {
    // One message for all three would leave a person who has an area, full of
    // pages, linked out to SharePoint, being told to go and create one.
    const none = architectureGapMessage("none");
    const external = architectureGapMessage("external");
    const empty = architectureGapMessage("empty");
    expect(new Set([none, external, empty]).size).toBe(3);
  });

  it("says what to do about a linked-out area rather than that it is missing", () => {
    expect(architectureGapMessage("external")).toMatch(/links out/);
    expect(architectureGapMessage("external")).not.toMatch(/no Architecture area/);
  });

  it("does not tell somebody with an empty area to go and create one", () => {
    expect(architectureGapMessage("empty")).toMatch(/no pages yet/);
    expect(architectureGapMessage("empty")).not.toMatch(/Set one up/);
  });
});
