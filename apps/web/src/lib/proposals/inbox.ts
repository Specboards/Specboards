import {
  agentRuns,
  and,
  desc,
  eq,
  inArray,
  features,
  proposals,
  releases,
  users,
  type Database,
} from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import type { WorkspaceScope } from "@/lib/store/types";

import { parseEvidence } from "./types";
import type { ProposalKind, ProposalTargetType } from "./types";

/**
 * What the review queue shows, and why it is not the notification centre.
 *
 * A notification is personal and read once. A review queue is shared work
 * with a lifecycle: two people see the same row, one of them acts on it, and
 * it leaves the queue for both. They also mean opposite things when empty. An
 * empty notification list is the normal resting state; an empty review queue
 * is the thing you want, and should say so rather than looking broken.
 *
 * ── What is in it ────────────────────────────────────────────────────────
 * Two kinds of row, because a person coming here is answering one question,
 * "is anything waiting on me", and the answer has two shapes:
 *
 *   - an open proposal from a run, which wants apply or dismiss
 *   - a run sitting at `awaiting_input`, which wants an answer before it can
 *     carry on
 *
 * Only `origin = 'run'` proposals. A conversation proposal already has a
 * reviewer, sitting in front of it, and dumping half-finished chats into a
 * shared queue would make this list useless within a day. That split is the
 * whole reason `origin` is a column.
 *
 * ── Visibility ───────────────────────────────────────────────────────────
 * Scoped by row-level security through `asUser`, not by a `where` clause
 * here. `proposals_read` resolves the real target rather than trusting the
 * denormalised `product_id`, which matters: `specboards_can_read_product(ws,
 * NULL)` is true for every member, so a product filter written by hand here
 * would be no filter at all for a proposal whose `product_id` was null.
 */

/** A row in the queue: something an agent produced that wants a decision. */
interface ReviewRow {
  id: string;
  /**
   * `stuck_apply` is a proposal somebody started applying that never
   * finished. It is in this list because it needs a person more than an open
   * one does, not less: the change may or may not have landed. Reconciliation
   * settles the ones that can be decided (see reconcile.ts) before the page
   * lists, so anything still showing here genuinely needs a human.
   */
  kind: "proposal" | "awaiting_run" | "stuck_apply";
  /** The proposal's own kind. Absent on an `awaiting_run` row. */
  proposalKind?: ProposalKind;
  targetType: ProposalTargetType | string;
  targetId: string;
  /**
   * Where the reader goes to act on it, and what the route needs. A feature
   * is addressed by `specId` and a release by its id, because that is what
   * the two apply endpoints take.
   */
  targetRef: string | null;
  targetTitle: string;
  productId: string | null;
  /** Who drafted it, resolved for display. Null when the actor is gone. */
  actorName: string | null;
  runId: string | null;
  /** How many citations the proposal carries, for the row's summary line. */
  evidenceCount: number;
  /** The item's level, for building its canonical permalink. Null for a release. */
  targetLevel: string | null;
  /** An `awaiting_run` row's question, which is the run's last summary. */
  summary: string | null;
  createdAt: Date;
}

/** Ten screens of queue is not a queue, it is a backlog nobody reads. */
const DEFAULT_LIMIT = 50;

/**
 * Open proposals produced by runs, newest first.
 *
 * The two target tables are joined separately and coalesced in TypeScript
 * rather than in SQL. A `CASE` across two joins reads worse and buys nothing:
 * at most one of the two can match, because `target_type` decides which.
 */
async function listOpenProposals(
  db: Database,
  scope: WorkspaceScope,
  limit: number,
): Promise<ReviewRow[]> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select({
        id: proposals.id,
        kind: proposals.kind,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        productId: proposals.productId,
        runId: proposals.runId,
        evidence: proposals.evidence,
        status: proposals.status,
        createdAt: proposals.createdAt,
        actorName: users.name,
        featureSpecId: features.specId,
        featureTitle: features.title,
        featureProductId: features.productId,
        featureLevel: features.level,
        releaseName: releases.name,
        releaseProductId: releases.productId,
      })
      .from(proposals)
      .leftJoin(users, eq(users.id, proposals.actorId))
      .leftJoin(
        features,
        and(
          eq(proposals.targetType, "feature"),
          eq(features.id, proposals.targetId),
        ),
      )
      .leftJoin(
        releases,
        and(
          eq(proposals.targetType, "release"),
          eq(releases.id, proposals.targetId),
        ),
      )
      .where(
        and(
          eq(proposals.workspaceId, scope.workspaceId),
          inArray(proposals.status, ["open", "applying"]),
          eq(proposals.origin, "run"),
        ),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(limit),
  );

  return rows.map((r) => ({
    id: r.id,
    kind: (r.status === "applying" ? "stuck_apply" : "proposal") as
      | "proposal"
      | "stuck_apply",
    proposalKind: r.kind as ProposalKind,
    targetType: r.targetType,
    targetId: r.targetId,
    targetRef: r.featureSpecId ?? (r.releaseName === null ? null : r.targetId),
    // A target the reader cannot resolve is named rather than hidden. RLS has
    // already decided they may see the proposal, so a blank row would be a
    // worse answer than saying the target is no longer readable.
    targetTitle: r.featureTitle ?? r.releaseName ?? "A target that has gone",
    productId: r.featureProductId ?? r.releaseProductId ?? r.productId,
    actorName: r.actorName,
    runId: r.runId,
    evidenceCount: parseEvidence(r.evidence).length,
    targetLevel: r.featureLevel ?? null,
    summary: null,
    createdAt: r.createdAt,
  }));
}

/**
 * Runs that have stopped and asked for something, newest first.
 *
 * These are in the same list as proposals rather than a tab of their own,
 * because the reader's question is "is anything waiting on me" and a stalled
 * run is as much an answer to that as a drafted change is. They differ in
 * what the row offers, not in why it is there.
 */
async function listAwaitingRuns(
  db: Database,
  scope: WorkspaceScope,
  limit: number,
): Promise<ReviewRow[]> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select({
        id: agentRuns.id,
        targetType: agentRuns.targetType,
        targetId: agentRuns.targetId,
        productId: agentRuns.productId,
        summary: agentRuns.summary,
        createdAt: agentRuns.createdAt,
        actorName: users.name,
        featureSpecId: features.specId,
        featureTitle: features.title,
        featureProductId: features.productId,
        featureLevel: features.level,
      })
      .from(agentRuns)
      .leftJoin(users, eq(users.id, agentRuns.agentId))
      .leftJoin(
        features,
        and(
          eq(agentRuns.targetType, "feature"),
          eq(features.id, agentRuns.targetId),
        ),
      )
      .where(
        and(
          eq(agentRuns.workspaceId, scope.workspaceId),
          eq(agentRuns.status, "awaiting_input"),
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit),
  );

  return rows.map((r) => ({
    id: r.id,
    kind: "awaiting_run" as const,
    targetType: r.targetType,
    targetId: r.targetId,
    targetRef: r.featureSpecId ?? null,
    targetTitle: r.featureTitle ?? "A target that has gone",
    productId: r.featureProductId ?? r.productId,
    actorName: r.actorName,
    runId: r.id,
    evidenceCount: 0,
    targetLevel: r.featureLevel ?? null,
    summary: r.summary,
    createdAt: r.createdAt,
  }));
}

/**
 * The queue, both kinds of row, newest first.
 *
 * Each half takes the full limit and the merged list is then cut back to it,
 * so a flood of one kind cannot push the other kind off the page entirely.
 * The alternative, splitting the limit in half, starves the common case where
 * there are no stalled runs at all.
 */
export async function listReviewQueue(
  db: Database,
  scope: WorkspaceScope,
  opts: { limit?: number } = {},
): Promise<ReviewRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 200);
  const [drafted, stalled] = await Promise.all([
    listOpenProposals(db, scope, limit),
    listAwaitingRuns(db, scope, limit),
  ]);
  return [...drafted, ...stalled]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}
