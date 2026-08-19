import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProposalStaleError,
  resolveProposal,
  resolveReleaseProposal,
  SpecConflictError,
} from "./api-client";

/**
 * Decoding a refused accept.
 *
 * The server half of this is covered against a real database in
 * `assistant.int.test.ts`. What is covered here is the wire boundary, which is
 * where the guard was previously being thrown away: the route returned the
 * current body on a 409 and the client turned it into a bare `Error`, so the
 * panel showed the refusal while still diffing against the version that had
 * just been refused. That is the stale-diff problem the guard exists to close,
 * so it is worth a test that fails if the body stops arriving.
 *
 * `apiFetch` reaches for `window` only to tag the org header, and returns null
 * for it under Node, so stubbing global `fetch` is the whole harness needed.
 */

function respond(status: number, payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolving a proposal on an item", () => {
  it("carries the current body off a stale refusal", async () => {
    respond(409, {
      error: "This item's description changed after the assistant drafted this.",
      currentBody: "What the colleague wrote instead.",
    });

    await expect(
      resolveProposal("spec-1", "msg-1", "accept"),
    ).rejects.toBeInstanceOf(ProposalStaleError);

    await expect(
      resolveProposal("spec-1", "msg-1", "accept"),
    ).rejects.toMatchObject({
      currentBody: "What the colleague wrote instead.",
    });
  });

  it("still reads a spec conflict as a conflict, not a stale refusal", async () => {
    // Both are 409s and both carry a version that won. A spec's can be merged
    // with, so it must keep raising the type that carries the sha to save
    // against; only the branch order in the client keeps these apart.
    respond(409, {
      error: "Someone else changed this spec.",
      conflict: {
        path: "specs/a.md",
        currentContent: "In git now.",
        currentBlobSha: "abc123",
      },
    });

    await expect(
      resolveProposal("spec-1", "msg-1", "accept"),
    ).rejects.toBeInstanceOf(SpecConflictError);
  });

  it("leaves an already-settled 409 as a plain error", async () => {
    // A proposal somebody else has already accepted is a 409 with no body to
    // redraw against. Keying the branch on the status alone would turn it into
    // a stale refusal carrying `undefined`, and the panel would blank the diff.
    respond(409, { error: "That proposal has already been resolved." });

    const err = await resolveProposal("spec-1", "msg-1", "accept").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProposalStaleError);
    expect((err as Error).message).toBe(
      "That proposal has already been resolved.",
    );
  });
});

describe("resolving a proposal on a release", () => {
  it("carries the current notes off a stale refusal", async () => {
    respond(409, {
      error: "These release notes changed after the assistant drafted this.",
      currentBody: "The notes as they now stand.",
    });

    await expect(
      resolveReleaseProposal("rel-1", "msg-1", "accept"),
    ).rejects.toMatchObject({
      name: "ProposalStaleError",
      currentBody: "The notes as they now stand.",
    });
  });

  it("leaves an already-settled 409 as a plain error", async () => {
    respond(409, { error: "That proposal has already been resolved." });

    const err = await resolveReleaseProposal("rel-1", "msg-1", "accept").catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(ProposalStaleError);
  });
});
