import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATUSES,
  canTransition,
  defaultWorkflow,
  flexibleTransitions,
  isTransitionMode,
  shortestTransitionPath,
  strictTransitions,
  transitionErrorMessage,
  workflowFromStages,
} from "./status.js";

const DEFAULT_STAGES = DEFAULT_STATUSES.filter((s) => s !== "archived");

const CUSTOM = [
  { key: "todo", label: "To do" },
  { key: "doing", label: "Doing" },
  { key: "shipped", label: "Shipped" },
];

describe("strictTransitions", () => {
  it("reproduces the built-in workflow exactly, edge for edge", () => {
    // The guarantee that matters: turning a workspace's mode to `strict` must
    // leave the long-standing default behavior untouched, including `done`
    // reopening straight to `in_progress` (the board's Done -> In Progress
    // drag), which a generic neighbours rule would not produce.
    expect(strictTransitions(DEFAULT_STAGES)).toEqual(
      defaultWorkflow.transitions,
    );
    expect(strictTransitions(DEFAULT_STAGES).done).toContain("in_progress");
  });

  it("returns a copy, so a caller cannot mutate the shared default map", () => {
    const mine = strictTransitions(DEFAULT_STAGES);
    mine.backlog!.push("done");
    expect(defaultWorkflow.transitions.backlog).not.toContain("done");
  });

  it("is one step forward, one step back, or archive for a custom vocabulary", () => {
    expect(strictTransitions(["todo", "doing", "shipped"])).toEqual({
      todo: ["doing", "archived"],
      doing: ["shipped", "todo", "archived"],
      shipped: ["doing", "archived"],
      archived: ["todo"],
    });
  });

  it("handles a two-stage workflow", () => {
    expect(strictTransitions(["open", "closed"])).toEqual({
      open: ["closed", "archived"],
      closed: ["open", "archived"],
      archived: ["open"],
    });
  });
});

describe("flexibleTransitions", () => {
  it("lets every stage reach every other, archived included", () => {
    expect(flexibleTransitions(["a", "b", "archived"])).toEqual({
      a: ["b", "archived"],
      b: ["a", "archived"],
      archived: ["a", "b"],
    });
  });
});

describe("workflowFromStages", () => {
  it("builds a pipeline in strict mode", () => {
    const wf = workflowFromStages(CUSTOM, "strict")!;
    expect(canTransition("todo", "doing", wf)).toBe(true);
    expect(canTransition("todo", "shipped", wf)).toBe(false);
    expect(canTransition("todo", "archived", wf)).toBe(true);
  });

  it("opens every move in flexible mode", () => {
    const wf = workflowFromStages(CUSTOM, "flexible")!;
    expect(canTransition("todo", "shipped", wf)).toBe(true);
    expect(canTransition("shipped", "todo", wf)).toBe(true);
  });

  it("keeps labels and appends archived in both modes", () => {
    for (const mode of ["strict", "flexible"] as const) {
      const wf = workflowFromStages(CUSTOM, mode)!;
      expect(wf.statuses).toEqual(["todo", "doing", "shipped", "archived"]);
      expect(wf.labels).toMatchObject({ todo: "To do", archived: "Archived" });
    }
  });

  it("returns null below two stages, whatever the mode", () => {
    expect(workflowFromStages([{ key: "only", label: "Only" }], "strict")).toBeNull();
    expect(workflowFromStages([], "flexible")).toBeNull();
  });
});

describe("isTransitionMode", () => {
  it("accepts the two modes and nothing else", () => {
    expect(isTransitionMode("strict")).toBe(true);
    expect(isTransitionMode("flexible")).toBe(true);
    for (const bad of ["open", "", "STRICT", null, undefined, 1, {}]) {
      expect(isTransitionMode(bad)).toBe(false);
    }
  });
});

describe("shortestTransitionPath", () => {
  it("is empty when already at the target", () => {
    expect(shortestTransitionPath("ready", "ready")).toEqual([]);
  });

  it("walks the strict default chain, which is the reported pain point", () => {
    // The customer's case: backlog -> in_review took four separate calls.
    expect(shortestTransitionPath("backlog", "in_review")).toEqual([
      "defining",
      "ready",
      "in_progress",
      "in_review",
    ]);
  });

  it("is a single hop in a flexible workflow", () => {
    const wf = workflowFromStages(CUSTOM, "flexible")!;
    expect(shortestTransitionPath("todo", "shipped", wf)).toEqual(["shipped"]);
  });

  it("never routes through archived, but reaches it as a destination", () => {
    const path = shortestTransitionPath("backlog", "done");
    expect(path).not.toContain("archived");
    expect(shortestTransitionPath("backlog", "archived")).toEqual(["archived"]);
  });

  it("returns null for a status outside the vocabulary", () => {
    expect(shortestTransitionPath("backlog", "nonsense")).toBeNull();
  });

  it("goes backward in one hop where the workflow allows it", () => {
    expect(shortestTransitionPath("done", "in_progress")).toEqual([
      "in_progress",
    ]);
  });
});

describe("transitionErrorMessage", () => {
  it("names both ways out of a multi-step move", () => {
    const msg = transitionErrorMessage("backlog", "in_review");
    expect(msg).toContain("Illegal transition: backlog -> in_review");
    expect(msg).toContain("Allowed from \"backlog\": defining, archived.");
    // The recovery hints: the flag, the route, and the setting.
    expect(msg).toContain("advance");
    expect(msg).toContain("defining -> ready -> in_progress");
    expect(msg).toContain("flexible");
  });

  it("lists the vocabulary for a status that doesn't exist", () => {
    const msg = transitionErrorMessage("backlog", "nonsense");
    expect(msg).toContain("is not a status in this workspace");
    expect(msg).toContain("backlog, defining");
    // No point offering to walk somewhere unreachable.
    expect(msg).not.toContain("Pass advance");
  });

  it("offers no route for a one-step move that is merely disallowed", () => {
    const wf = workflowFromStages(CUSTOM, "strict")!;
    // shipped -> archived is legal, so pick a genuinely illegal single step:
    // archived -> shipped (archived only returns to the first stage).
    const msg = transitionErrorMessage("archived", "shipped", wf);
    expect(msg).toContain("Illegal transition");
  });
});
