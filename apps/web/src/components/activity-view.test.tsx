import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityView } from "@/components/activity-view";
import type { ActivitySummary } from "@/lib/store/types";

/**
 * What this page renders is the whole of its correctness, so the two ways it
 * could mislead are asserted against the markup rather than against the
 * helpers underneath it:
 *
 * - a window reaching back before the ledger must say so, in words, above the
 *   chart, or its blank days read as a fall in the team's output
 * - a stage average must never appear without the number of spans behind it
 *
 * Rendered with react-dom/server: these are server components with no state or
 * effects, so static markup is the whole of what a reader sees.
 */

const WINDOW = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z" };

function summary(over: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    since: "2026-08-01T00:00:00.000Z",
    total: 12,
    byActor: [
      { actorType: "user", actorId: "u1", actorLabel: "Jane", count: 8 },
      { actorType: "sync", actorId: null, actorLabel: null, count: 4 },
    ],
    byField: [
      { type: "item.field_changed", field: "status", count: 7 },
      { type: "spec.body_changed", field: null, count: 5 },
    ],
    byDay: [{ day: "2026-08-06", count: 12 }],
    stageTime: [{ status: "in_progress", averageHours: 30, samples: 9 }],
    ...over,
  };
}

function render(over: Partial<ActivitySummary> = {}) {
  return renderToStaticMarkup(
    <ActivityView
      summary={summary(over)}
      window={WINDOW}
      rangeKey="30"
      scopeLabel="Specboards"
      basePath="/acme/specboards/activity"
    />,
  );
}

describe("where history begins", () => {
  it("says so when the window reaches back before the ledger", () => {
    const html = render({ since: "2026-08-05T10:00:00.000Z" });
    expect(html).toContain("Recording began on");
    // The sentence that stops a reader concluding the team slowed down.
    expect(html).toContain("not");
    expect(html).toContain("because nothing was being recorded then");
    expect(html).toContain("The first 4 days of this window");
  });

  it("does not cry gap when the window is covered in full", () => {
    const html = render({ since: "2026-07-01T00:00:00.000Z" });
    expect(html).toContain("this window is covered in full");
    expect(html).not.toContain("Recording began on");
  });

  it("says the whole window predates the ledger when it does", () => {
    const html = render({ since: "2026-08-20T00:00:00.000Z" });
    expect(html).toContain("This whole window predates the change ledger");
  });

  it("explains an empty ledger rather than showing zeroes", () => {
    const html = render({ since: null, total: 0, byActor: [], byField: [], byDay: [], stageTime: [] });
    expect(html).toContain("No changes recorded yet");
    // A zero total next to an empty chart would read as a dead month.
    expect(html).not.toContain("changes recorded in this window");
  });

  it("marks the unrecorded days in the chart, not only in the notice", () => {
    const html = render({ since: "2026-08-05T10:00:00.000Z" });
    expect(html).toContain("Not recorded");
    expect(html).toContain("2026: not recorded");
  });
});

describe("stage time", () => {
  it("carries the sample count beside every average", () => {
    const html = render();
    expect(html).toContain("30 hours");
    expect(html).toContain("9 spans");
  });

  it("scales the unit so a long stage is not quoted in hours", () => {
    const html = render({
      stageTime: [{ status: "in_review", averageHours: 412, samples: 30 }],
    });
    expect(html).toContain("17.2 days");
    expect(html).not.toContain("412");
  });

  it("marks an average drawn from too few spans", () => {
    const html = render({
      stageTime: [{ status: "in_review", averageHours: 5, samples: 2 }],
    });
    expect(html).toContain("(indicative)");
    expect(html).toContain("2 spans");
  });

  it("explains why a stage is missing rather than showing an empty table", () => {
    const html = render({ stageTime: [] });
    expect(html).toContain("No completed stage times yet");
  });
});

describe("breakdowns", () => {
  it("names actors and change kinds in prose, not stored keys", () => {
    const html = render();
    expect(html).toContain("Jane");
    expect(html).toContain("A change in git");
    expect(html).toContain("Status");
    expect(html).toContain("Spec rewritten");
    expect(html).not.toContain("item.field_changed");
  });
});
