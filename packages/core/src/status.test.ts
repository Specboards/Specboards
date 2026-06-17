import { describe, expect, it } from "vitest";

import { canTransition, defaultWorkflow, resolveWorkflow } from "./status.js";

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
