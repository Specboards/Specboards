import { describe, expect, it } from "vitest";

import {
  MAX_TRACE_STEPS,
  RunInputError,
  appendStep,
  isTerminal,
  parseError,
  parseReportedStatus,
  parseStep,
  parseSummary,
  parseTrace,
  parseTrigger,
} from "./types";

/**
 * Reading what an agent says about its own run.
 *
 * All of this is untrusted input from software we did not write, so the cases
 * that matter are the dishonest and the runaway ones: a status that would let
 * an agent disguise a failure, a clock it does not get to set, and a trace it
 * could otherwise grow until the row stopped fitting.
 */

const NOW = new Date("2026-09-15T12:00:00.000Z");

describe("the status an agent may report", () => {
  it("accepts the four it is allowed", () => {
    for (const s of ["running", "awaiting_input", "succeeded", "failed"]) {
      expect(parseReportedStatus(s)).toBe(s);
    }
  });

  it("refuses to let an agent cancel itself", () => {
    // Only a person stops a run. An agent that could report itself cancelled
    // could dress a failure up as somebody having asked it to stop.
    expect(() => parseReportedStatus("cancelled")).toThrow(RunInputError);
  });

  it("refuses to let an agent queue itself", () => {
    expect(() => parseReportedStatus("queued")).toThrow(RunInputError);
  });

  it("refuses anything else", () => {
    expect(() => parseReportedStatus("done")).toThrow(RunInputError);
    expect(() => parseReportedStatus(7)).toThrow(RunInputError);
    expect(() => parseReportedStatus(undefined)).toThrow(RunInputError);
  });
});

describe("what counts as finished", () => {
  it("knows the terminal set", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("knows a run waiting on a person is not finished", () => {
    // `awaiting_input` is the one that reads like an ending and is not: the
    // run is still open and a person can still steer or cancel it.
    expect(isTerminal("awaiting_input")).toBe(false);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
  });
});

describe("the trigger", () => {
  it("defaults to manual when nothing is said", () => {
    expect(parseTrigger(undefined)).toBe("manual");
    expect(parseTrigger(null)).toBe("manual");
  });

  it("takes the four primitives", () => {
    expect(parseTrigger("schedule")).toBe("schedule");
    expect(parseTrigger("assignment")).toBe("assignment");
  });

  it("refuses one it does not know", () => {
    expect(() => parseTrigger("vibes")).toThrow(RunInputError);
  });
});

describe("a step", () => {
  it("reads a bare string as a label", () => {
    expect(parseStep("Read 42 open ideas", NOW)).toEqual({
      at: NOW.toISOString(),
      label: "Read 42 open ideas",
    });
  });

  it("reads a label and detail", () => {
    expect(parseStep({ label: "Clustered", detail: "8 groups" }, NOW)).toEqual({
      at: NOW.toISOString(),
      label: "Clustered",
      detail: "8 groups",
    });
  });

  it("stamps our clock, not the agent's", () => {
    // The only field an agent could use to lie about ordering, and the trace
    // is read as a sequence.
    const step = parseStep(
      { label: "Did a thing", at: "1999-01-01T00:00:00.000Z" },
      NOW,
    );
    expect(step!.at).toBe(NOW.toISOString());
  });

  it("is nothing when there is nothing to record", () => {
    expect(parseStep(undefined, NOW)).toBeNull();
    expect(parseStep("   ", NOW)).toBeNull();
    expect(parseStep({ detail: "no label" }, NOW)).toBeNull();
  });
});

describe("the trace", () => {
  const step = (n: number) => ({ at: NOW.toISOString(), label: `step ${n}` });

  it("appends", () => {
    expect(appendStep([step(1)], step(2))).toHaveLength(2);
  });

  it("drops the oldest once it is full", () => {
    // An agent in a loop writes a step per iteration. What a reader wants is
    // how it ended, so the end is what survives.
    const full = Array.from({ length: MAX_TRACE_STEPS }, (_, i) => step(i));
    const next = appendStep(full, step(999));
    expect(next).toHaveLength(MAX_TRACE_STEPS);
    expect(next[next.length - 1]!.label).toBe("step 999");
    expect(next[0]!.label).toBe("step 1");
  });

  it("reads back what it can and skips what it cannot", () => {
    // Already-stored rows: one bad step must not cost the reader the others.
    const out = parseTrace([
      { at: NOW.toISOString(), label: "good" },
      { label: "no timestamp" },
      null,
      "not an object",
      { at: NOW.toISOString(), label: "also good", detail: "x" },
    ]);
    expect(out.map((s) => s.label)).toEqual(["good", "also good"]);
  });

  it("treats a non-list as an empty trace", () => {
    expect(parseTrace(undefined)).toEqual([]);
    expect(parseTrace({ label: "x" })).toEqual([]);
  });
});

describe("the text an agent writes for a person", () => {
  it("collapses a multi-line summary rather than refusing it", () => {
    // The card renders this on one line whatever it contains, and refusing a
    // whole report over a stray newline helps nobody.
    expect(parseSummary("Reading ideas\nand clustering them")).toBe(
      "Reading ideas and clustering them",
    );
  });

  it("is null when there is nothing usable", () => {
    expect(parseSummary("")).toBeNull();
    expect(parseSummary(undefined)).toBeNull();
    expect(parseError("  ")).toBeNull();
  });

  it("truncates rather than letting one field swamp the row", () => {
    expect(parseSummary("x".repeat(5_000))!.length).toBe(300);
  });
});
