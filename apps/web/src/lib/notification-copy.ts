import type { NotificationRecord } from "@/lib/store/types";

/**
 * What an inbox row says it is.
 *
 * The panel used to hardcode "mentioned you", which was true while a mention
 * was the only thing that could reach the inbox. Now every item assignment,
 * status change and comment does too, and they are not interchangeable: a
 * review outcome is something that happened to the reader's own work, with no
 * actor to name, while an assignment is something a specific person did.
 *
 * The snippet under the headline carries the detail (which item, which stage),
 * so the headline says only what kind of thing happened and who did it.
 *
 * Unknown types are given a plain heading rather than dropped. A row whose
 * snippet renders under a blank or wrong heading is worse than a generic one,
 * and this list will grow faster than every reader's deployment updates.
 */
interface NotificationHeadline {
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
  const actor = n.actorName ?? "Someone";
  switch (n.type) {
    case "spec_change_merged":
      return { actor: null, text: "Your change is live" };
    case "spec_change_closed":
      return { actor: null, text: "Your change was closed" };
    // "mention" is what these rows were called before the event catalog gave
    // every type a namespaced key. Old rows keep their old value (nothing
    // rewrites an inbox), so both spellings have to read the same.
    case "mention":
    case "comment.mentioned":
      return { actor, text: "mentioned you" };
    case "comment.created":
      return { actor, text: "commented" };
    case "item.assigned":
      return { actor, text: "assigned you an item" };
    case "item.status_changed":
      return { actor, text: "moved an item" };
    case "item.created":
      return { actor, text: "added an item" };
    // A ship is an event rather than a person's action, like a review outcome.
    case "release.shipped":
      return { actor: null, text: "A release shipped" };
    default:
      return n.actorName
        ? { actor: n.actorName, text: "updated this" }
        : { actor: null, text: "Something changed" };
  }
}
