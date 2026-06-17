import { describe, expect, it } from "vitest";

import { resolveEstimateConfig, rollUpEstimates } from "./estimate.js";
import { parseRepoConfigYaml } from "./config.js";

describe("resolveEstimateConfig", () => {
  it("falls back to the Fibonacci default when unconfigured", () => {
    expect(resolveEstimateConfig(null)).toEqual({
      label: "Estimate",
      scale: [1, 2, 3, 5, 8, 13, 21],
    });
  });

  it("reads a configured label and scale", () => {
    const config = parseRepoConfigYaml(
      ["version: 1", "estimate:", "  label: Points", "  scale: [1, 2, 4, 8]"].join(
        "\n",
      ),
    );
    expect(resolveEstimateConfig(config)).toEqual({
      label: "Points",
      scale: [1, 2, 4, 8],
    });
  });
});

describe("rollUpEstimates", () => {
  it("sums a subtree onto its root and leaves estimates intact", () => {
    const rolled = rollUpEstimates([
      { key: "epic", parentKey: null, estimate: null },
      { key: "a", parentKey: "epic", estimate: 3 },
      { key: "b", parentKey: "epic", estimate: 5 },
      { key: "solo", parentKey: null, estimate: 2 },
    ]);
    expect(rolled.get("epic")).toBe(8);
    expect(rolled.get("a")).toBe(3);
    expect(rolled.get("solo")).toBe(2);
  });

  it("rolls up across multiple levels and counts the root's own estimate", () => {
    const rolled = rollUpEstimates([
      { key: "epic", parentKey: null, estimate: 1 },
      { key: "mid", parentKey: "epic", estimate: 2 },
      { key: "leaf", parentKey: "mid", estimate: 4 },
    ]);
    expect(rolled.get("epic")).toBe(7);
    expect(rolled.get("mid")).toBe(6);
    expect(rolled.get("leaf")).toBe(4);
  });

  it("returns null for a subtree with no estimates anywhere", () => {
    const rolled = rollUpEstimates([
      { key: "epic", parentKey: null, estimate: null },
      { key: "child", parentKey: "epic", estimate: null },
    ]);
    expect(rolled.get("epic")).toBeNull();
    expect(rolled.get("child")).toBeNull();
  });

  it("does not loop forever on a malformed parent cycle", () => {
    const rolled = rollUpEstimates([
      { key: "x", parentKey: "y", estimate: 1 },
      { key: "y", parentKey: "x", estimate: 2 },
    ]);
    expect(rolled.get("x")).not.toBeUndefined();
    expect(rolled.get("y")).not.toBeUndefined();
  });
});
