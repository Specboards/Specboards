import { describe, expect, it } from "vitest";

import {
  estimatePromptTokens,
  estimateTokens,
  formatTokenEstimate,
} from "./estimate";

/**
 * The estimator is approximate by design, so these pin down the properties a
 * caller relies on rather than the exact arithmetic. Asserting the ratio itself
 * would make the constant untunable: changing 4 to 3.8 because it measured
 * better against real endpoints would break a dozen tests and tell us nothing.
 *
 * What must hold is that it never under-reports to zero, never goes backwards
 * as text grows, and never prints a figure precise enough to be mistaken for a
 * count.
 */
describe("estimateTokens", () => {
  it("is zero only for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBeGreaterThan(0);
  });

  it("rounds up, so a short string is never free", () => {
    // Under the ratio, this would be a fraction of a token. A guardrail that
    // counts short calls as zero is a guardrail a loop of short calls walks
    // straight past.
    expect(estimateTokens("hi")).toBe(1);
  });

  it("never decreases as text grows", () => {
    let previous = 0;
    let text = "";
    for (let i = 0; i < 50; i += 1) {
      text += "some more words ";
      const next = estimateTokens(text);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  it("is in the right order of magnitude for prose", () => {
    // ~1,000 characters of English. The claim is only that this lands within a
    // factor the caller's decision does not turn on, which is the whole reason
    // an approximation is acceptable here.
    const prose = "the quick brown fox jumps over the lazy dog ".repeat(23);
    const tokens = estimateTokens(prose);
    expect(tokens).toBeGreaterThan(150);
    expect(tokens).toBeLessThan(500);
  });
});

describe("estimatePromptTokens", () => {
  it("counts every message, not just the last", () => {
    const one = estimatePromptTokens([{ content: "hello there" }]);
    const three = estimatePromptTokens([
      { content: "hello there" },
      { content: "hello there" },
      { content: "hello there" },
    ]);
    expect(three).toBeGreaterThan(one * 2);
  });

  it("charges per-message overhead, so many short turns are not free", () => {
    // The failure this guards: a long thread of one-word answers estimated at
    // almost nothing, which is exactly the thread a grilling produces.
    const many = estimatePromptTokens(
      Array.from({ length: 20 }, () => ({ content: "yes" })),
    );
    expect(many).toBeGreaterThan(20);
  });

  it("is zero for no messages", () => {
    expect(estimatePromptTokens([])).toBe(0);
  });
});

describe("formatTokenEstimate", () => {
  it("rounds to two significant figures, so it cannot read as a count", () => {
    expect(formatTokenEstimate(1_203)).toBe("1,200");
    expect(formatTokenEstimate(47_912)).toBe("48,000");
  });

  it("leaves small numbers alone", () => {
    expect(formatTokenEstimate(7)).toBe("7");
    expect(formatTokenEstimate(42)).toBe("42");
  });

  it("does not print a negative or a fraction", () => {
    expect(formatTokenEstimate(0)).toBe("0");
    expect(formatTokenEstimate(-5)).toBe("0");
  });
});
