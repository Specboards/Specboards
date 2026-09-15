import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentRuns } from "./agent-runs";
import type { RunView } from "@/lib/api-client/runs";

// The component refreshes the page after acting. Nothing here acts, but the
// hook is called during render and needs a router to exist.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

/**
 * What the runs strip says before anybody touches it.
 *
 * The properties worth pinning in markup are the ones a reader would be
 * misled by if they broke: controls offered over a run that has already
 * finished, controls offered to somebody who cannot use them, and a cost
 * figure for work we did not pay for.
 */

const MEMBERS = [
  { userId: "agent-1", name: "Atlas agent", email: "atlas@example.com", role: "service" as const, deactivatedAt: null },
  { userId: "user-1", name: "Jo", email: "jo@example.com", role: "owner" as const, deactivatedAt: null },
];

function run(over: Partial<RunView> = {}): RunView {
  return {
    id: "run-1",
    status: "running",
    trigger: "assignment",
    summary: "Reading 42 open ideas",
    error: null,
    steer: null,
    trace: [],
    agentId: "agent-1",
    actorType: "agent",
    startedAt: "2026-09-15T12:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-09-15T12:00:00.000Z",
    tokens: null,
    ...over,
  };
}

const render = (runs: RunView[], canEdit = true) =>
  renderToStaticMarkup(
    <AgentRuns runs={runs} members={MEMBERS} canEdit={canEdit} />,
  );

describe("the runs strip", () => {
  it("names the agent and says what it said it is doing", () => {
    const html = render([run()]);
    expect(html).toContain("Atlas agent");
    expect(html).toContain("Reading 42 open ideas");
  });

  it("offers the two levers over a run still going", () => {
    const html = render([run()]);
    expect(html).toContain("Ask to stop");
    expect(html).toContain("Leave a note");
  });

  it("promises only what stopping can actually do", () => {
    // The button cannot reach a connected agent, and saying so where it is
    // pressed is the difference between a limitation and a broken feature.
    expect(render([run()])).toContain(
      "Stopping marks the run and tells the agent next time it reports",
    );
  });

  it("offers nothing over a run that has finished", () => {
    const html = render([
      run({ status: "succeeded", finishedAt: "2026-09-15T12:30:00.000Z" }),
    ]);
    expect(html).toContain("Finished");
    expect(html).not.toContain("Ask to stop");
    expect(html).not.toContain("Leave a note");
  });

  it("offers nothing to a reader who cannot act", () => {
    // A read-only member still sees the record: what happened to the item is
    // not privileged. What they must not get is a button that 403s.
    const html = render([run()], false);
    expect(html).toContain("Reading 42 open ideas");
    expect(html).not.toContain("Ask to stop");
  });

  it("says whose move it is, not what the state is called", () => {
    expect(render([run({ status: "awaiting_input" })])).toContain(
      "Waiting for you",
    );
  });

  it("shows a token count only when we did the spending", () => {
    // Null is "we do not know", which is the honest answer for an agent on
    // its own key. Rendering it as 0 would claim the work was free.
    expect(render([run()])).not.toContain("tokens");
    expect(
      render([run({ tokens: { prompt: 1_200, completion: 800 } })]),
    ).toContain("2,000 tokens");
  });

  it("shows a failure in the agent's own words", () => {
    const html = render([
      run({
        status: "failed",
        error: "The repo refused the commit: branch is protected.",
        finishedAt: "2026-09-15T12:05:00.000Z",
      }),
    ]);
    expect(html).toContain("Failed");
    expect(html).toContain("branch is protected");
  });

  it("says a note is still waiting to be picked up", () => {
    // Otherwise somebody leaves a second note thinking the first did nothing.
    expect(render([run({ steer: "Skip the duplicates" })])).toContain(
      "waiting for this agent to pick up",
    );
  });

  it("counts the trace rather than dumping it open", () => {
    const html = render([
      run({
        trace: [
          { at: "2026-09-15T12:01:00.000Z", label: "Listed ideas" },
          { at: "2026-09-15T12:02:00.000Z", label: "Clustered", detail: "8 groups" },
        ],
      }),
    ]);
    expect(html).toContain("2 steps");
    expect(html).toContain("8 groups");
  });
});
