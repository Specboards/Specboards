import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client/assistant", () => ({
  getAssistantThread: vi.fn(),
  getReleaseAssistantThread: vi.fn(),
  askAssistant: vi.fn(),
  askReleaseAssistant: vi.fn(),
  resolveProposal: vi.fn(),
  resolveReleaseProposal: vi.fn(),
}));

const api = await import("@/lib/api-client/assistant");
const { assistantApi, subjectBodyNoun, subjectId, subjectNoun } = await import(
  "./subject"
);

/**
 * Which endpoint a panel talks to.
 *
 * The one place an item/release mix-up could hide. Six calls in three pairs,
 * and picking the wrong half of a pair does not throw: a release panel wired to
 * the item thread would load a conversation about something else entirely and
 * look like it worked. Nothing else in the panel is subject-aware, so if this
 * is right the rest cannot get it wrong.
 */

beforeEach(() => {
  vi.clearAllMocks();
});

describe("naming the subject", () => {
  it("reads the id off whichever kind it is", () => {
    expect(subjectId({ kind: "item", specId: "s1" })).toBe("s1");
    expect(subjectId({ kind: "release", releaseId: "r1" })).toBe("r1");
  });

  it("uses the words a reader would use", () => {
    expect(subjectNoun({ kind: "item", specId: "s1" })).toBe("item");
    expect(subjectNoun({ kind: "release", releaseId: "r1" })).toBe("release");
    // A release's body is its notes, not its description.
    expect(subjectBodyNoun({ kind: "item", specId: "s1" })).toBe("description");
    expect(subjectBodyNoun({ kind: "release", releaseId: "r1" })).toBe("notes");
  });
});

describe("an item panel", () => {
  const calls = assistantApi(true, "spec-1");

  it("loads the item thread and not the release one", () => {
    void calls.loadThread();
    expect(api.getAssistantThread).toHaveBeenCalledWith("spec-1");
    expect(api.getReleaseAssistantThread).not.toHaveBeenCalled();
  });

  it("sends a turn to the item endpoint, passing the options through", () => {
    const opts = { skillKey: "grill" };
    void calls.sendTurn("why?", opts);
    expect(api.askAssistant).toHaveBeenCalledWith("spec-1", "why?", opts);
    expect(api.askReleaseAssistant).not.toHaveBeenCalled();
  });

  it("resolves against the item's own proposals route", () => {
    void calls.sendResolution("m1", "accept", { body: "edited" });
    expect(api.resolveProposal).toHaveBeenCalledWith("spec-1", "m1", "accept", {
      body: "edited",
    });
    expect(api.resolveReleaseProposal).not.toHaveBeenCalled();
  });
});

describe("a release panel", () => {
  const calls = assistantApi(false, "rel-1");

  it("loads the release thread and not the item one", () => {
    void calls.loadThread();
    expect(api.getReleaseAssistantThread).toHaveBeenCalledWith("rel-1");
    expect(api.getAssistantThread).not.toHaveBeenCalled();
  });

  it("sends a turn to the release endpoint", () => {
    void calls.sendTurn("why?", {});
    expect(api.askReleaseAssistant).toHaveBeenCalledWith("rel-1", "why?", {});
    expect(api.askAssistant).not.toHaveBeenCalled();
  });

  it("resolves against the release's own proposals route", () => {
    void calls.sendResolution("m1", "reject", {});
    expect(api.resolveReleaseProposal).toHaveBeenCalledWith(
      "rel-1",
      "m1",
      "reject",
      {},
    );
    expect(api.resolveProposal).not.toHaveBeenCalled();
  });
});
