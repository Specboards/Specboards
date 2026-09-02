import { describe, expect, it } from "vitest";

import { assistantErrorAdvice } from "./advice";

/**
 * What the panel tells someone when their model endpoint refuses.
 *
 * The branching that decides whether a stuck customer gets unstuck is all in
 * this one pure function. The panel's markup depends on `usePathname`, which
 * needs a router context this repo has no test harness for, and its first
 * render is a loading skeleton anyway, so asserting on it would pin almost
 * nothing.
 *
 * The behaviour behind the panel, that a question reaches a model and both
 * turns are persisted, is covered against a real database and a real runtime
 * in `lib/assistant.int.test.ts`.
 */

describe("advice for a model failure", () => {
  it("sends someone to settings when the fix is in Specboards", () => {
    for (const kind of ["not_configured", "auth", "model", "unreachable"]) {
      expect(assistantErrorAdvice(kind, "…").settingsLink).toBe(true);
    }
  });

  it("does not send someone to settings when the fix is at the provider", () => {
    for (const kind of ["quota", "rate_limit", "unknown", "protocol"]) {
      expect(assistantErrorAdvice(kind, "…").settingsLink).toBe(false);
    }
  });

  it("tells a rate limit to wait", () => {
    expect(assistantErrorAdvice("rate_limit", "…").text).toMatch(/again/i);
  });

  it("does not tell an exhausted account to wait", () => {
    // The one that matters. OpenAI reports "out of credit" as a 429, which is
    // indistinguishable from a rate limit unless something makes the
    // distinction. "Try again shortly" here sends a customer into a retry loop
    // that can never succeed.
    const advice = assistantErrorAdvice("quota", "…");
    expect(advice.text).not.toMatch(/try again|shortly/i);
    expect(advice.text).toMatch(/credit|spend cap/i);
  });

  it("says a rejected key may have been revoked rather than blaming the endpoint", () => {
    expect(assistantErrorAdvice("auth", "…").text).toMatch(/revoked|rotated/i);
  });

  it("passes the adapter's own message through when it has nothing to add", () => {
    // An unrecognised kind must not be swallowed into a generic sentence: the
    // adapter's message is the only information anyone has at that point.
    const detail = "the endpoint returned 502";
    expect(assistantErrorAdvice("unknown", detail).text).toBe(detail);
  });
});

/**
 * How much of a thread is shown at once.
 *
 * The panel sits inside an item page, not in a chat window. Left whole, a
 * conversation of any length pushes the composer and the rest of the card off
 * the screen, and the card stops being about the item. The failure mode worth
 * testing is the off-by-one: a window that keeps the oldest turns instead of
 * the newest looks almost right and is useless.
 */
