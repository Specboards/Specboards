import { and, eq, proposals, users, type Database } from "@specboards/db";

import { asUser, type ScopedTx } from "@/lib/db-scope";
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
  /** Moves on every write, including the claim. What 'stuck' is measured from. */
  updatedAt: Date;
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
  updatedAt: proposals.updatedAt,
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

interface CreateProposalInput {
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
  /**
   * A decision the proposal arrives already carrying.
   *
   * Only for materialising a legacy `assistant_messages` proposal, which may
   * have been accepted or rejected years before this table existed. A row
   * created any other way starts `open`, and carrying the outcome across is
   * what stops an already-accepted proposal becoming acceptable again.
   */
  status?: ProposalStatus;
  resolvedBy?: string | null;
  resolvedAt?: Date | null;
  result?: unknown;
}

function values(input: CreateProposalInput) {
  return {
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
    status: input.status ?? "open",
    resolvedBy: input.resolvedBy ?? null,
    resolvedAt: input.resolvedAt ?? null,
    result: input.result ?? null,
  };
}

/**
 * Insert inside a transaction the caller already owns.
 *
 * Exists because a conversation proposal has to be written in the SAME
 * transaction as the message it hangs off. A turn that recorded the answer but
 * not its proposal would render an Accept button with nothing behind it, and
 * the pair being atomic is the only thing that rules that out.
 */
export async function insertProposal(
  tx: ScopedTx,
  input: CreateProposalInput,
): Promise<ProposalRow | null> {
  const [row] = await tx
    .insert(proposals)
    .values(values(input))
    // A message carries at most one proposal (`proposals_source_message_uq`).
    // Losing the race is not an error: it means somebody else materialised the
    // same legacy row a moment earlier, and the caller re-reads theirs.
    .onConflictDoNothing()
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}


/** The proposal attached to one conversation turn, if it has been recorded. */
export async function getProposalBySourceMessage(
  db: Database,
  scope: WorkspaceScope,
  messageId: string,
): Promise<ProposalRow | null> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(proposals)
      .where(
        and(
          eq(proposals.workspaceId, scope.workspaceId),
          eq(proposals.sourceMessageId, messageId),
        ),
      )
      .limit(1),
  );
  return row ? toRow(row) : null;
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
/**
 * Take the decision, atomically.
 *
 * `applying` for an apply, `dismissed` for a turn-down. The asymmetry is the
 * point: dismissing writes nothing to the target, so there is no window in
 * which the record could be ahead of reality and no intermediate state to
 * pass through. Applying does write, so it claims `applying` first and is
 * settled by {@link settle} once the write has actually happened.
 */
export async function claim(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  status: "applying" | "dismissed",
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

/**
 * Put a claim back when the write it was taken for did not happen.
 *
 * Predicated on the row still being `applying`, so this can only ever undo
 * the claim it was called for. Without that predicate it was an unconditional
 * reset by id: harmless while the only caller was the failing request itself,
 * and a way to reopen somebody else's applied proposal the moment it was not.
 */
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
      .where(and(eq(proposals.id, id), eq(proposals.status, "applying"))),
  );
}

/**
 * Mark an applied proposal applied, recording what the write produced.
 *
 * Status and result move in ONE statement, after the write has happened.
 * They used to be two: the claim wrote `applied` and `recordResult` wrote the
 * result afterwards, which left a window where a row said a change had landed
 * and carried no record of what landed. Writing them together removes that
 * window, and means a row reading `applied` always carries its outcome.
 *
 * Predicated on `applying`, so a proposal somebody else has since released or
 * superseded is not quietly re-settled by a late caller. Returns false when
 * the predicate did not match, which the caller reports rather than swallows.
 */
export async function settle(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  result: unknown,
): Promise<boolean> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .update(proposals)
      .set({ status: "applied", result, updatedAt: new Date() })
      .where(and(eq(proposals.id, id), eq(proposals.status, "applying")))
      .returning({ id: proposals.id }),
  );
  return rows.length > 0;
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



