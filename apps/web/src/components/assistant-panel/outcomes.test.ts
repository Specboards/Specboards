import { describe, expect, it } from "vitest";

import type { ProposalOutcome } from "@/lib/api-client/assistant";
import { ProposalStaleError, SpecConflictError } from "@/lib/api-client/specs";
import type { AssistantMessageView } from "@/lib/assistant-service";

import { resolutionEffect, resolutionFailure, turnResult } from "./outcomes";
import type { AssistantSubject } from "./subject";

/**
 * What the panel does with each thing that can come back.
 *
 * These are worth pinning down because the mistakes they prevent are all
 * invisible ones. A cancelled turn that reported failure would put an error
 * panel over a deliberate Stop. An accept that refetched when the change went
 * to review would redraw the old text and read as if the accept had failed. A
 * stale proposal that did not hand back the winning body would leave the
 * reviewer told their base is gone while still looking at it.
 *
 * The panel's own markup is untestable here: it depends on `usePathname`, which
 * needs a router context this repo has no harness for.
 */

const ITEM: AssistantSubject = { kind: "item", specId: "spec-1" };
const RELEASE: AssistantSubject = { kind: "release", releaseId: "rel-1" };

const message = { id: "m1" } as AssistantMessageView;

function outcome(over: Partial<ProposalOutcome> = {}): ProposalOutcome {
  return { message, body: "new body", ...over };
}

describe("a finished turn", () => {
  it("hands back the persisted pair when it landed", () => {
    const turns = [message];
    expect(turnResult({ ok: true, turns })).toEqual({ kind: "landed", turns });
  });

  it("reports a cancel as a cancel, not as a failure", () => {
    // Stop is deliberate. An error panel over it would be the panel arguing
    // with the person who pressed the button.
    expect(turnResult({ ok: false, cancelled: true })).toEqual({
      kind: "cancelled",
    });
  });

  it("turns a model failure into advice, keeping the settings link", () => {
    const result = turnResult({
      ok: false,
      error: { kind: "auth", message: "401" },
    });
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.advice.settingsLink).toBe(true);
  });

  it("does not offer settings for a failure at the provider", () => {
    const result = turnResult({
      ok: false,
      error: { kind: "rate_limit", message: "slow down" },
    });
    expect(result.kind === "failed" && result.advice.settingsLink).toBe(false);
  });
});

describe("resolving a proposal", () => {
  it("says nothing happened when it was rejected", () => {
    expect(resolutionEffect("reject", outcome(), ITEM)).toEqual({
      reseedHost: null,
      toast: "Left as it is.",
      refresh: false,
    });
  });

  it("does not refetch when the change went to review instead of live", () => {
    // The whole point. Nothing on the default branch changed, so a refresh
    // would redraw the old text and look like the accept had failed.
    const effect = resolutionEffect(
      "accept",
      outcome({ pullRequest: { number: 7, url: "u", created: true } }),
      ITEM,
    );
    expect(effect).toEqual({
      reseedHost: null,
      toast: "Sent for review as #7",
      refresh: false,
    });
  });

  it("distinguishes opening a review from adding to one already open", () => {
    const effect = resolutionEffect(
      "accept",
      outcome({ pullRequest: { number: 7, url: "u", created: false } }),
      ITEM,
    );
    expect(effect.toast).toBe("Added to review #7");
  });

  it("reseeds the host and refetches when the change went live", () => {
    // Reseeding is not politeness: the editor above the panel is holding the
    // old body and autosaves it back on the next keystroke.
    expect(resolutionEffect("accept", outcome(), ITEM)).toEqual({
      reseedHost: "new body",
      toast: "Applied to the item.",
      refresh: true,
    });
  });

  it("says so when the change merged with someone else's edit", () => {
    const effect = resolutionEffect("accept", outcome({ mergedWith: 3 }), ITEM);
    expect(effect.toast).toBe(
      "Applied, and merged with a change made in the meantime.",
    );
    expect(effect.refresh).toBe(true);
  });

  it("names the subject the reader is looking at", () => {
    expect(resolutionEffect("accept", outcome(), RELEASE).toast).toBe(
      "Applied to the release.",
    );
  });
});

describe("a resolution that did not go through", () => {
  it("hands back the version that won, on a conflict", () => {
    const err = new SpecConflictError("Someone else changed this.", {
      currentContent: "theirs",
    } as SpecConflictError["conflict"]);
    const failed = resolutionFailure(err, ITEM);
    expect(failed.body).toBe("theirs");
    expect(failed.message).toContain("Someone else changed this.");
    expect(failed.message).toContain("ask the assistant again");
  });

  it("hands back the current body on a stale proposal", () => {
    const err = new ProposalStaleError("This changed.", "current");
    expect(resolutionFailure(err, ITEM).body).toBe("current");
  });

  it("calls a release's body its notes and an item's its description", () => {
    const err = new ProposalStaleError("This changed.", "current");
    expect(resolutionFailure(err, RELEASE).message).toContain("current notes");
    expect(resolutionFailure(err, ITEM).message).toContain(
      "current description",
    );
  });

  it("leaves the diff alone for an error it cannot explain", () => {
    // No body means no reseed, which is right: guessing here would redraw the
    // diff against something nobody has confirmed.
    expect(resolutionFailure(new Error("nope"), ITEM)).toEqual({
      message: "nope",
      body: null,
    });
  });

  it("has something to say about a thrown non-error", () => {
    expect(resolutionFailure("nope", ITEM).message).toBe(
      "That did not go through.",
    );
  });
});
