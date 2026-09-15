import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  proposals,
  users,
  type Database,
} from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import type { WorkspaceScope } from "@/lib/store/types";

import {
  parseEvidence,
  type Evidence,
  type ProposalActorType,
  type ProposalKind,
  type ProposalOrigin,
  type ProposalStatus,
  type ProposalTargetType,
} from "./types";

/**
 * Reading and writing proposal rows. No business rules live here: whether a
 * caller may apply a proposal is the handler's question, and applying it is
 * the write path's. This file only knows how a proposal is stored.
 *
 * Everything goes through `asUser`, so row-level security is what scopes a
 * read rather than a `where` clause somebody has to remember. The one place
 * that matters most is {@link claim}, which is the atomic decision.
 */

export interface ProposalRow {
  id: string;
  workspaceId: string;
  productId: string | null;
  origin: ProposalOrigin;
  sourceMessageId: string | null;
  runId: string | null;
  actorId: string | null;
  actorType: ProposalActorType;
  kind: ProposalKind;
  targetType: ProposalTargetType;
  targetId: string;
  payload: unknown;
  baseVersion: string | null;
  evidence: Evidence[];
  status: ProposalStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  result: unknown;
  createdAt: Date;
}

const COLUMNS = {
  id: proposals.id,
  workspaceId: proposals.workspaceId,
  productId: proposals.productId,
  origin: proposals.origin,
  sourceMessageId: proposals.sourceMessageId,
  runId: proposals.runId,
  actorId: proposals.actorId,
  actorType: proposals.actorType,
  kind: proposals.kind,
  targetType: proposals.targetType,
  targetId: proposals.targetId,
  payload: proposals.payload,
  baseVersion: proposals.baseVersion,
  evidence: proposals.evidence,
  status: proposals.status,
  resolvedBy: proposals.resolvedBy,
  resolvedAt: proposals.resolvedAt,
  result: proposals.result,
  createdAt: proposals.createdAt,
};

/** Narrow the text columns the database has already CHECKed. */
function toRow(r: Record<string, unknown>): ProposalRow {
  return {
    ...(r as unknown as ProposalRow),
    origin: r.origin as ProposalOrigin,
    actorType: r.actorType as ProposalActorType,
    kind: r.kind as ProposalKind,
    targetType: r.targetType as ProposalTargetType,
    status: r.status as ProposalStatus,
    evidence: parseEvidence(r.evidence),
  };
}

export interface CreateProposalInput {
  workspaceId: string;
  productId: string | null;
  origin: ProposalOrigin;
  sourceMessageId?: string | null;
  runId?: string | null;
  actorId: string | null;
  actorType: ProposalActorType;
  kind: ProposalKind;
  targetType: ProposalTargetType;
  targetId: string;
  payload: unknown;
  baseVersion: string | null;
  evidence?: Evidence[];
}

export async function createProposal(
  db: Database,
  scope: WorkspaceScope,
  input: CreateProposalInput,
): Promise<ProposalRow> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .insert(proposals)
      .values({
        workspaceId: input.workspaceId,
        productId: input.productId,
        origin: input.origin,
        sourceMessageId: input.sourceMessageId ?? null,
        runId: input.runId ?? null,
        actorId: input.actorId,
        actorType: input.actorType,
        kind: input.kind,
        targetType: input.targetType,
        targetId: input.targetId,
        payload: input.payload,
        baseVersion: input.baseVersion,
        evidence: input.evidence ?? [],
      })
      .returning(COLUMNS),
  );
  // The insert either returns its row or raised; a missing one means the
  // schema and this file disagree about the columns, which is a bug to see
  // rather than a null to thread through every caller.
  if (!row) throw new Error("Proposal insert returned no row.");
  return toRow(row);
}

/** One proposal, or null when it is gone or the caller cannot see its target. */
export async function getProposal(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<ProposalRow | null> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(proposals)
      .where(
        and(eq(proposals.id, id), eq(proposals.workspaceId, scope.workspaceId)),
      )
      .limit(1),
  );
  return row ? toRow(row) : null;
}

/**
 * The proposals attached to a set of conversation turns, keyed by message id.
 *
 * Batched rather than one query per turn: the panel renders a whole thread at
 * once, and asking per message is how a twenty-turn conversation becomes
 * twenty round trips.
 */
export async function getProposalsForMessages(
  db: Database,
  scope: WorkspaceScope,
  messageIds: string[],
): Promise<Map<string, ProposalRow>> {
  if (messageIds.length === 0) return new Map();
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(proposals)
      .where(
        and(
          eq(proposals.workspaceId, scope.workspaceId),
          inArray(proposals.sourceMessageId, messageIds),
        ),
      ),
  );
  const out = new Map<string, ProposalRow>();
  for (const r of rows) {
    const row = toRow(r);
    if (row.sourceMessageId) out.set(row.sourceMessageId, row);
  }
  return out;
}

/**
 * Take the decision, atomically, *before* anything is applied.
 *
 * Lifted wholesale from `assistant-proposals.claim`, including the reasoning:
 * between reading a row and writing to its target, a second request (two
 * people with the queue open, or one person double-clicking Apply) can do the
 * whole thing too, and the target gets written twice. A conditional update is
 * the only operation here that is atomic, so it is what decides who won, and
 * it runs first. If the write then fails the claim is released, which is why
 * this is a claim and not a record.
 *
 * The guard moved from `proposal_outcome IS NULL` on a message to
 * `status = 'open'` on a proposal. That is the whole difference.
 */
export async function claim(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  status: Exclude<ProposalStatus, "open">,
): Promise<{ resolvedAt: Date } | null> {
  const now = new Date();
  const claimed = await asUser(db, scope.userId, (tx) =>
    tx
      .update(proposals)
      .set({
        status,
        resolvedBy: scope.userId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(proposals.id, id),
          // The whole guard. Anything already decided is not ours to decide.
          eq(proposals.status, "open"),
        ),
      )
      .returning({ id: proposals.id }),
  );
  return claimed.length > 0 ? { resolvedAt: now } : null;
}

/** Put a claim back when the write it was taken for did not happen. */
export async function releaseClaim(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<void> {
  await asUser(db, scope.userId, (tx) =>
    tx
      .update(proposals)
      .set({
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, id)),
  );
}

/**
 * Record what applying produced, after it has produced it.
 *
 * Separate from the claim for the reason `settled()` gives about a commit sha:
 * a result written before the write exists is a record of something that may
 * not have happened, and a sha no commit matches is worse than no sha.
 */
export async function recordResult(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  result: unknown,
): Promise<void> {
  await asUser(db, scope.userId, (tx) =>
    tx
      .update(proposals)
      .set({ result, updatedAt: new Date() })
      .where(eq(proposals.id, id)),
  );
}

/** Who settled a proposal, for the "someone got there first" message. */
export async function resolverName(
  db: Database,
  scope: WorkspaceScope,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1),
  );
  return row?.name ?? null;
}

/**
 * The review queue: open proposals nobody was watching arrive.
 *
 * Filtered to `origin = 'run'` on purpose. A conversation proposal is already
 * in front of the person who asked for it, and listing those here would fill a
 * shared queue with everybody's half-finished chats. Same object, same
 * lifecycle, different surface.
 *
 * Product scoping is the RLS policy's job, not a clause here: the policy
 * resolves each row's real target, which is the check that cannot be fooled by
 * a wrong `product_id`.
 */
export async function listInbox(
  db: Database,
  scope: WorkspaceScope,
  limit = 50,
): Promise<ProposalRow[]> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(proposals)
      .where(
        and(
          eq(proposals.workspaceId, scope.workspaceId),
          eq(proposals.origin, "run"),
          eq(proposals.status, "open"),
        ),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(limit),
  );
  return rows.map(toRow);
}

/** Everything proposed against one target, newest first, for its card. */
export async function listForTarget(
  db: Database,
  scope: WorkspaceScope,
  targetType: ProposalTargetType,
  targetId: string,
): Promise<ProposalRow[]> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(proposals)
      .where(
        and(
          eq(proposals.workspaceId, scope.workspaceId),
          eq(proposals.targetType, targetType),
          eq(proposals.targetId, targetId),
        ),
      )
      .orderBy(desc(proposals.createdAt)),
  );
  return rows.map(toRow);
}

/** Open proposals against a target, for superseding them. */
export async function openForTarget(
  db: Database,
  scope: WorkspaceScope,
  targetType: ProposalTargetType,
  targetId: string,
): Promise<ProposalRow[]> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(proposals)
      .where(
        and(
          eq(proposals.workspaceId, scope.workspaceId),
          eq(proposals.targetType, targetType),
          eq(proposals.targetId, targetId),
          eq(proposals.status, "open"),
          isNull(proposals.resolvedAt),
        ),
      ),
  );
  return rows.map(toRow);
}
