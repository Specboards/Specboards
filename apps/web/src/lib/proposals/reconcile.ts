import { and, eq, features, lt, proposals, type Database } from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import { contentVersion } from "@/lib/assistant-service";
import { getStore } from "@/lib/store";
import type { WorkspaceScope } from "@/lib/store/types";

import { settle } from "./store";
import { parseSpecContent } from "./types";
import type { ProposalRow } from "./store";

/**
 * Deciding what happened to a proposal that was left mid-apply.
 *
 * `applying` means somebody claimed a proposal and the write to its target
 * was started. Almost always the same request finishes the job a moment
 * later. What this file is for is the case where it did not: the process was
 * killed, the machine went away, the deploy rolled. The row is then honest
 * but unresolved, and left alone it sits in the queue forever.
 *
 * ── What can and cannot be decided ───────────────────────────────────────
 * For a whole-text proposal the question is answerable: if the target now
 * holds exactly the text that was proposed, the write landed, and the row can
 * settle itself. That is not a guess. The proposal records the base the draft
 * was made against, and `spec_content` proposals are refused at apply time
 * unless the target still matches that base, so the target holding the
 * proposed text means this proposal put it there.
 *
 * For a metadata change set it is NOT answerable, and this does not pretend
 * otherwise. An item sitting at `ready` after a proposal to move it to
 * `ready` may have been moved by the proposal or by a person doing the same
 * thing by hand, and those are different facts about who decided. Guessing
 * would put a name against a decision somebody did not make, which is worse
 * than leaving the row for a human to look at. Those stay `applying` and the
 * review surface says so.
 *
 * ── Why a grace period ───────────────────────────────────────────────────
 * An apply in flight is indistinguishable from one that died. Reconciling
 * eagerly would race a live request and could settle a row whose write is
 * about to fail and release the claim. The window only has to outlast a
 * normal apply, which is one HTTP round trip to git at worst.
 */

/**
 * How long a row must have sat in `applying` before it is treated as
 * abandoned rather than in flight.
 */
const STUCK_AFTER_MS = 2 * 60 * 1000;

/** What reconciliation concluded about one row. */
type Reconciliation =
  | { outcome: "applied" }
  | { outcome: "in_flight" }
  | { outcome: "undecidable"; why: string };

/**
 * Decide one stuck proposal, settling it when the answer is certain.
 *
 * Returns what it concluded rather than mutating the caller's row, so a read
 * path can render the truth without having to re-query.
 */
export async function reconcile(
  db: Database,
  scope: WorkspaceScope,
  row: ProposalRow,
  now: Date = new Date(),
): Promise<Reconciliation> {
  if (row.status !== "applying") return { outcome: "in_flight" };
  // Measured from `updatedAt`, which is what `listStuck` and the partial index
  // in migration 0018 both use. For an `applying` row it is the claim time,
  // because nothing else writes to the row while it is in that state, but the
  // two have to name the same column or a row can be listed as stuck and then
  // judged in flight by the function that was sent to decide about it.
  const since = now.getTime() - row.updatedAt.getTime();
  if (since < STUCK_AFTER_MS) return { outcome: "in_flight" };

  if (row.kind !== "spec_content") {
    return {
      outcome: "undecidable",
      why: "A change set cannot be told apart from the same change made by hand.",
    };
  }

  let proposed: string;
  try {
    proposed = parseSpecContent(row.payload).body.trim();
  } catch {
    return { outcome: "undecidable", why: "Its payload can no longer be read." };
  }

  const current = await currentText(db, scope, row);
  if (current === null) {
    return { outcome: "undecidable", why: "Its target is no longer here." };
  }
  if (contentVersion(current.trim()) !== contentVersion(proposed)) {
    // The target does not hold the proposed text. That is not proof the write
    // failed: it could have landed and then been edited. Undecidable is the
    // honest answer, and it is the one that leaves a person in charge.
    return {
      outcome: "undecidable",
      why: "Its target does not hold the proposed text.",
    };
  }

  // `settle` is predicated on the row still being `applying`, so a live
  // request that finishes between the read above and this write wins and
  // this becomes a no-op rather than a second settlement.
  await settle(db, scope, row.id, { body: current, reconciled: true });
  return { outcome: "applied" };
}

/**
 * The target's text now, or null when it cannot be read.
 *
 * No permission check: row-level security has already decided the caller may
 * see this proposal, and reading the target's text to answer "did this land"
 * tells them nothing they could not read from the target itself.
 */
async function currentText(
  db: Database,
  scope: WorkspaceScope,
  row: ProposalRow,
): Promise<string | null> {
  const store = await getStore();
  if (row.targetType === "release") {
    const release = (await store.listReleases(scope)).find(
      (r) => r.id === row.targetId,
    );
    return release ? (release.releaseNotesBody ?? "") : null;
  }
  if (row.targetType !== "feature") return null;

  // `target_id` holds `features.id`; the rest of the service speaks `specId`.
  const [hit] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({ specId: features.specId })
      .from(features)
      .where(
        and(
          eq(features.id, row.targetId),
          eq(features.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  if (!hit) return null;
  const feature = await store.getFeature(hit.specId, scope);
  return feature ? (feature.content ?? "") : null;
}

/**
 * Decide about every proposal left mid-apply for long enough to count.
 *
 * Called from the review queue's page before it lists, rather than from
 * inside the listing query. Reconciling is a write, and a read path that
 * quietly writes is one nobody expects to have side effects; making the page
 * ask for it keeps `listReviewQueue` a read and puts the decision where
 * somebody is actually about to look at the result.
 *
 * Best effort. A reconciliation that throws must not take the queue down with
 * it: the rows are still rendered, just unresolved, which is the state they
 * were already in.
 */
export async function reconcileStuck(
  db: Database,
  scope: WorkspaceScope,
  now: Date = new Date(),
  limit = 50,
): Promise<void> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  try {
    const rows = await asUser(db, scope.userId, (tx) =>
      tx
        .select(STUCK_COLUMNS)
        .from(proposals)
        .where(
          and(
            eq(proposals.workspaceId, scope.workspaceId),
            eq(proposals.status, "applying"),
            lt(proposals.updatedAt, cutoff),
          ),
        )
        .orderBy(proposals.updatedAt)
        .limit(limit),
    );
    for (const row of rows) {
      await reconcile(db, scope, row as unknown as ProposalRow, now);
    }
  } catch (err) {
    console.warn("[proposals] reconciling stuck applies failed:", err);
  }
}

/** Just what {@link reconcile} reads. */
const STUCK_COLUMNS = {
  id: proposals.id,
  kind: proposals.kind,
  payload: proposals.payload,
  status: proposals.status,
  targetType: proposals.targetType,
  targetId: proposals.targetId,
  resolvedAt: proposals.resolvedAt,
  updatedAt: proposals.updatedAt,
};
