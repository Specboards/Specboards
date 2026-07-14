import { describe, expect, it } from "vitest";

import {
  canTransition,
  defaultWorkflow,
  isForwardTransition,
  resolveWorkflow,
  transitionErrorMessage,
  workflowFromStages,
} from "./status.js";

describe("resolveWorkflow", () => {
  it("falls back to the default workflow when statuses are absent or too few", () => {
    expect(resolveWorkflow(null)).toBe(defaultWorkflow);
    expect(resolveWorkflow({})).toBe(defaultWorkflow);
    expect(resolveWorkflow({ statuses: ["only-one"] })).toBe(defaultWorkflow);
  });

  it("uses custom statuses with explicit transitions", () => {
    const wf = resolveWorkflow({
      statuses: ["todo", "doing", "done"],
      transitions: { todo: ["doing"], doing: ["done"], done: [] },
    });
    expect(wf.statuses).toEqual(["todo", "doing", "done"]);
    expect(canTransition("todo", "doing", wf)).toBe(true);
    expect(canTransition("todo", "done", wf)).toBe(false);
  });

  it("allows any transition among custom statuses when transitions are omitted", () => {
    const wf = resolveWorkflow({ statuses: ["a", "b", "c"] });
    expect(canTransition("a", "c", wf)).toBe(true);
    expect(canTransition("c", "a", wf)).toBe(true);
    // a status can always stay put
    expect(canTransition("a", "a", wf)).toBe(true);
  });
});

describe("transitionErrorMessage", () => {
  it("names the moves allowed from the current status", () => {
    const msg = transitionErrorMessage("backlog", "ready", defaultWorkflow);
    expect(msg).toContain("Illegal transition: backlog -> ready");
    expect(msg).toContain('Allowed from "backlog": defining, archived.');
  });

  it("lists the full vocabulary when the target status is unknown", () => {
    const msg = transitionErrorMessage("backlog", "todo", defaultWorkflow);
    expect(msg).toContain('"todo" is not a status in this workspace');
    expect(msg).toContain("valid statuses are: backlog, defining, ready");
  });

  it("does not add the vocabulary hint when the target is a real status", () => {
    const msg = transitionErrorMessage("backlog", "done", defaultWorkflow);
    expect(msg).not.toContain("is not a status");
  });
});

describe("isForwardTransition", () => {
  it("is true only when the target sits later in the stage order", () => {
    expect(isForwardTransition("backlog", "in_progress")).toBe(true);
    expect(isForwardTransition("in_review", "done")).toBe(true);
  });

  it("is false for backward moves and no-ops", () => {
    expect(isForwardTransition("in_progress", "backlog")).toBe(false);
    expect(isForwardTransition("done", "done")).toBe(false);
  });

  it("never treats archiving as forward, even though archived is last", () => {
    // `archived` is appended to custom workflows, so a naive index check would
    // call every move to it "forward"; gates must not fire on archiving.
    const wf = workflowFromStages([
      { key: "todo", label: "To do" },
      { key: "shipping", label: "Shipping" },
    ])!;
    expect(wf.statuses).toContain("archived");
    expect(isForwardTransition("todo", "archived", wf)).toBe(false);
    expect(isForwardTransition("todo", "shipping", wf)).toBe(true);
  });

  it("is false when either status is unknown to the workflow", () => {
    expect(isForwardTransition("mystery", "done")).toBe(false);
    expect(isForwardTransition("backlog", "mystery")).toBe(false);
  });
});
