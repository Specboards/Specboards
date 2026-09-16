import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cadencePayload, type CadenceDraft } from "./cadence-fields";
import { SchedulesCard } from "./schedules-card";
import type { ScheduleView } from "@/lib/api-client/schedules";

/**
 * What the schedules list says before anybody touches it.
 *
 * The property worth pinning in markup is the one this whole feature exists
 * for: a schedule that stopped working has to be obvious on the row, not
 * behind a disclosure. A settings page that renders a broken schedule looking
 * exactly like a healthy one is the silent failure the card was written
 * against, and nothing else in the stack would catch it.
 *
 * Rendering to static markup keeps these plain assertions about output. What
 * happens behind the buttons is covered by `dispatcher.int.test.ts`.
 */

function schedule(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "sched-1",
    name: "Weekly gap check",
    skillKey: "gaps",
    targetSpecId: "spec-1",
    cadence: { every: "week", hour: 9, minute: 0, weekday: 1 },
    timeZone: "Europe/London",
    cadenceLabel: "Every Monday at 09:00 (Europe/London)",
    enabled: true,
    nextRunAt: "2026-09-21T08:00:00.000Z",
    lastRunAt: null,
    lastRunId: null,
    lastError: null,
    consecutiveFailures: 0,
    ...over,
  };
}

const render = (schedules: ScheduleView[], canManage = true) =>
  renderToStaticMarkup(
    <SchedulesCard initialSchedules={schedules} canManage={canManage} />,
  );

describe("the schedules card", () => {
  it("says where schedules are created when there are none", () => {
    // An empty list that only says "nothing here" leaves somebody hunting for
    // an Add button that is deliberately on another screen.
    const html = render([]);
    expect(html).toMatch(/Open an item/);
  });

  it("shows the cadence as the sentence the server built", () => {
    // Rendered from `cadenceLabel` rather than reassembled here, so the list,
    // the item card and the failure email cannot describe one schedule three
    // different ways.
    expect(render([schedule()])).toContain("Every Monday at 09:00");
  });

  it("puts a failure on the row rather than behind a disclosure", () => {
    const html = render([
      schedule({ lastError: "No model is connected to this workspace.", consecutiveFailures: 1 }),
    ]);
    expect(html).toContain("No model is connected to this workspace.");
  });

  it("counts repeated failures, because once is a blip and three is broken", () => {
    const html = render([
      schedule({ lastError: "The model call failed.", consecutiveFailures: 2 }),
    ]);
    expect(html).toMatch(/failed 2 times in a row/);
  });

  it("says a schedule was switched off, not merely that it is off", () => {
    // The distinction is the whole point: "Off" is something you did, and
    // "switched off after repeated failures" is something that happened to you.
    const offByHand = render([schedule({ enabled: false })]);
    expect(offByHand).toContain("Off");
    expect(offByHand).not.toMatch(/repeated failures/);

    const gaveUp = render([
      schedule({ enabled: false, consecutiveFailures: 3, lastError: "boom" }),
    ]);
    expect(gaveUp).toMatch(/Switched off after repeated failures/);
  });

  it("does not claim a next run for a schedule that is off", () => {
    const html = render([schedule({ enabled: false })]);
    expect(html).toMatch(/Not scheduled while it is off/);
  });

  it("offers no controls to somebody who cannot manage them", () => {
    const html = render([schedule()], false);
    expect(html).not.toMatch(/>Edit</);
    expect(html).not.toMatch(/>Delete</);
    expect(html).toMatch(/Only the workspace owner/);
  });

  it("does not sit with an edit form open", () => {
    // The same rule as the Agents card beside it: a form on screen is a claim
    // that you have something to type.
    const html = render([schedule()]);
    expect(html).not.toMatch(/How often/);
  });
});

describe("cadencePayload", () => {
  const draft: CadenceDraft = {
    every: "week",
    hour: 9,
    minute: 30,
    weekday: 3,
    day: 15,
    timeZone: "Europe/London",
  };

  it("sends only the field the cadence actually uses", () => {
    // The draft carries both `weekday` and `day` so switching between shapes
    // in the form does not lose what was typed. Sending both would have the
    // server store a monthly day on a weekly schedule, which reads as a bug
    // the first time anybody looks at the row.
    expect(cadencePayload(draft)).toEqual({
      every: "week",
      hour: 9,
      minute: 30,
      weekday: 3,
    });
    expect(cadencePayload({ ...draft, every: "month" })).toEqual({
      every: "month",
      hour: 9,
      minute: 30,
      day: 15,
    });
    expect(cadencePayload({ ...draft, every: "day" })).toEqual({
      every: "day",
      hour: 9,
      minute: 30,
    });
  });

  it("never sends the time zone, which is its own column", () => {
    expect(cadencePayload(draft)).not.toHaveProperty("timeZone");
  });
});
