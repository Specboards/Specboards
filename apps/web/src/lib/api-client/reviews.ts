import { apiFetch } from "./request";

/**
 * Deciding about a proposal from the review queue.
 *
 * Posts to the target's own endpoint, not to a proposals one, and that is
 * deliberate rather than incidental: an API key's scope is derived from the
 * first path segment, so accepting an edit to an item costs `features:write`,
 * the same grant as editing it by hand. A `/api/v1/proposals/:id` endpoint
 * would have derived `proposals:write`, and a key holding that plus
 * `assistant:write` could draft a change and approve its own draft. See the
 * note on the route.
 */

interface ReviewDecision {
  id: string;
  status: string;
  resolvedAt: string;
  /** The target's text afterwards, when the kind has one. */
  body: string;
  commitSha?: string;
  pullRequest?: { number: number; url: string; created: boolean };
  mergedWith?: number;
}

/** Which endpoint a row's target is decided through. */
export type ReviewTarget =
  | { kind: "feature"; specId: string }
  | { kind: "release"; id: string };

/**
 * Apply or dismiss a proposal by its id.
 *
 * A 409 is the interesting failure and is left as a plain error carrying the
 * server's message, because in this surface the two reasons for one read the
 * same to the reader: somebody else got there first, or the target moved
 * underneath the draft. Either way the row is stale and the answer is to
 * refresh the queue, which is what the caller does.
 */
export async function decideReview(
  target: ReviewTarget,
  proposalId: string,
  action: "accept" | "reject",
): Promise<ReviewDecision> {
  const body = JSON.stringify({ proposalId, action });
  // Two calls written out rather than one over a computed path, and the
  // method inline rather than hoisted with the rest of the init.
  // `api-client-routes` walks these modules and matches every `apiFetch`
  // against the route tree; it reads the path and the method straight out of
  // the call, so anything it cannot read statically is a request nobody is
  // checking exists, and a hoisted `init` makes it assume GET. The repetition
  // is what keeps this module inside the guard.
  const res =
    target.kind === "feature"
      ? await apiFetch(
          `/api/v1/features/${encodeURIComponent(target.specId)}/proposals`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          },
        )
      : await apiFetch(
          `/api/v1/releases/${encodeURIComponent(target.id)}/proposals`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          },
        );
  const payload = (await res.json().catch(() => null)) as
    | (ReviewDecision & { error?: string })
    | null;
  if (!res.ok) {
    throw new Error(
      payload?.error ?? `That did not go through (${res.status}).`,
    );
  }
  return payload as ReviewDecision;
}
