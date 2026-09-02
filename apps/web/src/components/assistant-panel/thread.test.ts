import { describe, expect, it } from "vitest";

import type { AssistantMessageView } from "@/lib/assistant-service";

import { RECENT_TURNS, threadWindow } from "./thread";

/** Which turns are on screen, and how many are being held back. */

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
