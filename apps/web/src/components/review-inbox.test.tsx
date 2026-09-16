import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReviewInbox, type ReviewRowView } from "./review-inbox";

// Dismissing refreshes the page. Nothing here dismisses, but the hook runs
// during render and needs a router to exist.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

/**
 * What the review queue says before anybody touches it.
 *
 * The properties worth pinning in markup are the ones a reader would be
 * actively misled by: a link that would 404, a Dismiss button over something
 * that cannot be dismissed, and an empty state that reads as breakage when it
 * is in fact the desired outcome.
 */

function row(over: Partial<ReviewRowView> = {}): ReviewRowView {
  return {
    id: "p-1",
    kind: "proposal",
    proposalKind: "item_metadata",
    targetType: "feature",
    targetId: "feat-1",
    targetRef: "spec-1",
    targetTitle: "Throttle the public API",
    targetLevel: "work",
    productKey: "web",
    actorName: "Atlas agent",
    runId: "run-1",
    evidenceCount: 3,
    summary: null,
    createdAt: "2026-09-15T10:00:00.000Z",
    ...over,
  };
}

const render = (rows: ReviewRowView[]) =>
  renderToStaticMarkup(<ReviewInbox initial={rows} org="acme" />);

describe("an empty queue", () => {
  it("reads as the desired state, not as an error", () => {
    const html = render([]);
    expect(html).toContain("Nothing waiting on you");
    // No "no results" or "try again" phrasing: there is nothing wrong.
    expect(html.toLowerCase()).not.toContain("error");
  });
});

describe("a drafted change", () => {
  it("names the target, the agent and what kind of change it is", () => {
    const html = render([row()]);
    expect(html).toContain("Throttle the public API");
    expect(html).toContain("Atlas agent");
    expect(html).toContain("Field changes");
  });

  it("links to the item's canonical permalink, level and all", () => {
    expect(render([row()])).toContain('href="/acme/web/backlog/work/spec-1"');
  });

  it("counts the evidence so a reader can tell a cited change from a guess", () => {
    expect(render([row({ evidenceCount: 3 })])).toContain("3 sources");
    expect(render([row({ evidenceCount: 1 })])).toContain("1 source");
    expect(render([row({ evidenceCount: 0 })])).not.toContain("0 source");
  });

  it("offers Dismiss, because turning something down needs no more context", () => {
    expect(render([row()])).toContain(">Dismiss<");
  });

  it("sends a release row to the roadmap instead of the backlog", () => {
    const html = render([
      row({ targetType: "release", targetRef: "rel-1", targetLevel: null }),
    ]);
    expect(html).toContain('href="/acme/web/roadmap"');
  });
});

describe("a row whose target has gone", () => {
  // RLS let the reader see the proposal, so hiding the row would be a worse
  // answer than saying the target cannot be opened.
  const orphan = row({ targetRef: null, productKey: null });

  it("says so rather than offering a link that would 404", () => {
    const html = render([orphan]);
    expect(html).toContain("Target unavailable");
    expect(html).not.toContain(">Review<");
  });

  it("offers no Dismiss either, since there is no endpoint to send it to", () => {
    expect(render([orphan])).not.toContain(">Dismiss<");
  });
});

describe("a run that stopped to ask something", () => {
  const asking = row({
    kind: "awaiting_run",
    proposalKind: undefined,
    summary: "Which of the two pricing pages did you mean?",
  });

  it("shows the question, which is the whole reason it is in the list", () => {
    const html = render([asking]);
    expect(html).toContain("Which of the two pricing pages");
    expect(html).toContain("Waiting for an answer");
  });

  it("is not dismissable: a run is answered on the item, not turned down here", () => {
    expect(render([asking])).not.toContain(">Dismiss<");
  });
});

describe("the summary line", () => {
  it("counts changes and waiting runs separately", () => {
    const html = render([
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "c", kind: "awaiting_run", proposalKind: undefined }),
    ]);
    expect(html).toContain("2 changes to review");
    expect(html).toContain("1 run waiting for an answer");
  });

  it("says nothing about waiting runs when there are none", () => {
    expect(render([row()])).not.toContain("waiting for an answer");
  });

  it("uses the singular for one change", () => {
    expect(render([row()])).toContain("1 change to review");
  });
});
