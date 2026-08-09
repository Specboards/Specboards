import type { NotificationRecord } from "@/lib/store/types";

/**
 * What an inbox row says it is.
 *
 * The panel used to hardcode "mentioned you", which was true while a mention
 * was the only thing that could reach the inbox. Now a review outcome does too,
 * and the two are not interchangeable: a merge is something that happened to
 * the reader's own work, with no actor to name.
 *
 * Unknown types are given a plain heading rather than dropped. A row whose
 * snippet renders under a blank or wrong heading is worse than a generic one,
 * and this list will grow faster than every reader's deployment updates.
 */
export interface NotificationHeadline {
  /**
   * The person whose action this was, rendered emphasised, or null when there
   * isn't one. An outcome has no actor on purpose: naming whoever clicked the
   * button would read as blame on a close, and a merge is a thing that
   * happened rather than a thing done to the reader.
   */
  actor: string | null;
  /** The rest of the sentence, which follows the actor when there is one. */
  text: string;
}

export function notificationHeadline(n: NotificationRecord): NotificationHeadline {
  switch (n.type) {
    case "spec_change_merged":
      return { actor: null, text: "Your change is live" };
    case "spec_change_closed":
      return { actor: null, text: "Your change was closed" };
    case "mention":
      return { actor: n.actorName ?? "Someone", text: "mentioned you" };
    default:
      return n.actorName
        ? { actor: n.actorName, text: "updated this" }
        : { actor: null, text: "Something changed" };
  }
}
