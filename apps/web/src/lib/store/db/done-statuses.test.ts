import { describe, expect, it } from "vitest";

import { doneStatusesFrom } from "./context";

/**
 * Which status means "finished".
 *
 * Every progress figure the store derives (hierarchy roll-up, cycle totals,
 * goal delivery, release progress) hangs on this one answer, and it used to be
 * the literal string "done". A workspace that renamed its last stage therefore
 * reported all of them as zero: not an error anyone could see, just a product
 * that looked permanently stalled. These pin the layering that replaced it.
 */

const stage = (productId: string | null, key: string) => ({ productId, key });

describe("resolving the done status", () => {
  it("is the built-in terminal stage when nothing is configured", () => {
    expect(doneStatusesFrom([], []).keyFor(null)).toBe("done");
  });

  it("is the last configured stage, whatever it is called", () => {
    const done = doneStatusesFrom(
      [stage(null, "todo"), stage(null, "doing"), stage(null, "shipped")],
      [],
    );
    expect(done.keyFor(null)).toBe("shipped");
    expect(done.isDone("shipped")).toBe(true);
    // The old behaviour: "done" is not a stage here at all, and treating it as
    // finished is what made every figure read zero.
    expect(done.isDone("done")).toBe(false);
  });

  it("never treats archived as finished", () => {
    // Archiving is how a team says they are not doing something. Counting it as
    // delivery would let abandoning work look like shipping it.
    const done = doneStatusesFrom(
      [stage(null, "todo"), stage(null, "shipped"), stage(null, "archived")],
      [],
    );
    expect(done.keyFor(null)).toBe("shipped");
    expect(done.isDone("archived")).toBe(false);
  });

  it("gives a product with its own stages its own terminal stage", () => {
    const done = doneStatusesFrom(
      [
        stage(null, "todo"),
        stage(null, "done"),
        stage("p1", "queued"),
        stage("p1", "live"),
      ],
      [],
    );
    expect(done.keyFor("p1")).toBe("live");
    expect(done.isDone("live", "p1")).toBe(true);
    // A product that defined nothing follows the workspace default, and one
    // product's vocabulary never leaks into another's.
    expect(done.keyFor("p2")).toBe("done");
    expect(done.isDone("live", "p2")).toBe(false);
  });

  it("reports every done status for the filters that cannot ask per row", () => {
    const done = doneStatusesFrom(
      [stage(null, "todo"), stage(null, "done"), stage("p1", "live")],
      [],
    );
    expect(done.allKeys().sort()).toEqual(["done", "live"]);
  });

  it("falls back to the repo config's vocabulary before the built-in one", () => {
    const done = doneStatusesFrom(
      [],
      [{ config: { version: 1, statuses: ["open", "wip", "delivered"] } }],
    );
    expect(done.keyFor(null)).toBe("delivered");
  });

  it("prefers configured stages over the repo config", () => {
    // Settings is the more specific layer, the same order `resolveWorkflowFor`
    // uses to build the workflow itself. The two must not disagree about which
    // stage is last.
    const done = doneStatusesFrom(
      [stage(null, "todo"), stage(null, "shipped")],
      [{ config: { version: 1, statuses: ["open", "wip", "delivered"] } }],
    );
    expect(done.keyFor(null)).toBe("shipped");
  });

  it("ignores a config it cannot parse, or one too short to be a workflow", () => {
    expect(doneStatusesFrom([], [{ config: null }]).keyFor(null)).toBe("done");
    expect(doneStatusesFrom([], [{ config: { version: 9 } }]).keyFor(null)).toBe(
      "done",
    );
    expect(
      doneStatusesFrom([], [{ config: { version: 1, statuses: ["only"] } }])
        .keyFor(null),
    ).toBe("done");
  });
});
