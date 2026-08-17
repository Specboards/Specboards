import { describe, expect, it } from "vitest";

import {
  assistantErrorAdvice,
  RECENT_TURNS,
  threadWindow,
} from "./assistant-panel";
import type { AssistantMessageView } from "@/lib/assistant-service";

/**
 * What the panel tells someone when their model endpoint refuses.
 *
 * Only the advice mapping is covered here, deliberately. The panel's markup
 * depends on `usePathname`, which needs a router context this repo has no test
 * harness for, and its first render is a loading skeleton anyway, so asserting
 * on it would pin almost nothing. The branching that actually decides whether a
 * stuck customer gets unstuck is all in this function, and it is a pure one.
 *
 * The behaviour behind the panel - that a question reaches a model and both
 * turns are persisted - is covered against a real database and a real runtime
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
describe("the slice of the thread on screen", () => {
  const turn = (i: number) =>
    ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
      authorId: "u1",
      authorName: "Ada",
      model: null,
      createdAt: "2026-08-17T10:00:00.000Z",
    }) as AssistantMessageView;

  const thread = (n: number) => Array.from({ length: n }, (_, i) => turn(i));

  it("shows a short thread whole", () => {
    const { visible, hidden } = threadWindow(thread(RECENT_TURNS), false);
    expect(visible).toHaveLength(RECENT_TURNS);
    expect(hidden).toBe(0);
  });

  it("keeps the newest turns, not the oldest", () => {
    const { visible, hidden } = threadWindow(thread(10), false);
    expect(visible).toHaveLength(RECENT_TURNS);
    expect(hidden).toBe(10 - RECENT_TURNS);
    // The end of the conversation is the part you are still in.
    expect(visible.at(-1)!.content).toBe("turn 9");
    expect(visible[0]!.content).toBe(`turn ${10 - RECENT_TURNS}`);
  });

  it("counts exactly what it is holding back", () => {
    // The button says "Show N earlier messages", so N being wrong is a visible
    // lie about the conversation.
    const { visible, hidden } = threadWindow(thread(7), false);
    expect(hidden + visible.length).toBe(7);
  });

  it("shows everything once asked", () => {
    const { visible, hidden } = threadWindow(thread(30), true);
    expect(visible).toHaveLength(30);
    expect(hidden).toBe(0);
  });

  it("handles an empty thread", () => {
    const { visible, hidden } = threadWindow([], false);
    expect(visible).toEqual([]);
    expect(hidden).toBe(0);
  });
});
