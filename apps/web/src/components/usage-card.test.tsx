import { describe, expect, it } from "vitest";

import { capUsedPercent, periodLabel } from "./usage-card";

/**
 * Only the two pure helpers, deliberately, for the same reason
 * `assistant-panel.test.tsx` covers only its advice mapping: the card's markup
 * is a settings panel whose interesting behaviour is a fetch, and asserting on
 * it would pin almost nothing. What matters here is the arithmetic behind the
 * bar, because a spend meter that reads wrong is worse than no meter: somebody
 * makes a decision on it.
 *
 * The accounting itself, and the caps, are covered against a real database in
 * `lib/usage.int.test.ts`.
 */
describe("capUsedPercent", () => {
  it("is null when there is no cap to be a share of", () => {
    expect(capUsedPercent(5_000, null)).toBeNull();
  });

  it("is null for a zero cap rather than dividing by it", () => {
    // A cap of zero is a real instruction ("stop entirely"), and every call is
    // refused under it, so there is no meaningful proportion to draw.
    expect(capUsedPercent(0, 0)).toBeNull();
  });

  it("reports the share of the budget spent", () => {
    expect(capUsedPercent(250, 1_000)).toBe(25);
    expect(capUsedPercent(999, 1_000)).toBe(100);
  });

  it("clamps an overshoot rather than drawing past the end of the bar", () => {
    // Caps can be overshot: the check is a guardrail, not a payment
    // authorization, and two calls in flight can both pass it. A bar drawn at
    // 140% reads as a rendering fault instead of as the overshoot it is, and
    // the figure beside it already states the real number.
    expect(capUsedPercent(1_400, 1_000)).toBe(100);
  });

  it("is zero before anything is spent", () => {
    expect(capUsedPercent(0, 1_000)).toBe(0);
  });
});

describe("periodLabel", () => {
  it("names the month in UTC, not the reader's timezone", () => {
    // The instant is the UTC month boundary, and a reader west of Greenwich
    // would otherwise be shown the previous month for the whole of the first
    // day: the totals under it are UTC, so the heading has to be too.
    expect(periodLabel("2026-08-01T00:00:00.000Z")).toBe("August 2026");
  });
});
