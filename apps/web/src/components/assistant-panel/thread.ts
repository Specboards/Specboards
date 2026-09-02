import type { AssistantMessageView } from "@/lib/assistant-service";

/**
 * How much of the thread is on screen before anyone asks for more.
 *
 * A conversation is append-only and the interesting end is the bottom, but the
 * panel lives inside an item page rather than in a chat window: left whole, a
 * dozen exchanges push the composer, the goals, the relationships and
 * everything else on the card hundreds of pixels down, and the card stops being
 * about the item. Two exchanges is enough to see what was just asked and how it
 * was answered, which is the context you need to ask the next thing.
 */
export const RECENT_TURNS = 4;

/**
 * Above this, a settled message is collapsed to a preview.
 *
 * Chosen in characters rather than by measuring rendered height: measuring
 * means a layout pass, a resize observer, and a flash of the full message
 * before it snaps shut. Characters are a coarse proxy and the cost of getting
 * it slightly wrong is one extra "Show more" on a message that did not need it.
 */
export const LONG_MESSAGE_CHARS = 1_200;

/**
 * The slice of the thread to render, and how much is being held back.
 *
 * Kept as a pure function because the off-by-one here is the whole feature: a
 * window that drops the newest turn instead of the oldest looks almost right
 * and is useless, and that is not something you notice by reading it.
 */
export function threadWindow(
  messages: AssistantMessageView[],
  showAll: boolean,
): { visible: AssistantMessageView[]; hidden: number } {
  if (showAll || messages.length <= RECENT_TURNS) {
    return { visible: messages, hidden: 0 };
  }
  return {
    // The tail, not the head: the end of a conversation is the part you are
    // still in.
    visible: messages.slice(-RECENT_TURNS),
    hidden: messages.length - RECENT_TURNS,
  };
}

/** Compact clock time for a turn, with the full timestamp on hover. */
export function turnTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
