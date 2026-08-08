import type { GithubLink } from "@/lib/store/types";

/**
 * Changes to a spec that are proposed but not yet live.
 *
 * A pending change is a pull request **Specboards opened for a spec edit**,
 * still open. Three exclusions carry the weight here, and each one is a way of
 * telling somebody their document is waiting for review when it is not:
 *
 * - `headBranch === null` is a pull request someone linked to the card by hand.
 *   Only the spec write path sets that column, so it is what separates "a change
 *   to this spec" from "a pull request that is related to this work". A card
 *   linked to the engineering PR that implements it would otherwise announce a
 *   spec edit that nobody made.
 * - `inherited` links belong to a descendant's spec. The proposal is real, but
 *   it is a change to a different document than the one on screen.
 * - A closed or merged review is finished. A merged one is already the live
 *   text, so calling it pending would point at a review that has happened.
 */
export function pendingSpecChanges(links: GithubLink[]): GithubLink[] {
  return links.filter(
    (l) =>
      !l.inherited &&
      l.kind === "pull_request" &&
      l.state === "open" &&
      l.headBranch !== null,
  );
}
