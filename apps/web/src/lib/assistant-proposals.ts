import {
  and,
  assistantMessages,
  eq,
  users,
  type Database,
} from "@specboards/db";

import { asUser } from "@/lib/db-scope";

import { parseAnswer } from "@/lib/ai/proposals";
import {
  ProposalInvalidError,
  ProposalNotFoundError,
} from "@/lib/proposals/errors";
import { applyProposal, dismissProposal } from "@/lib/proposals/service";
import {
  getProposalBySourceMessage,
  insertProposal,
  type ProposalRow,
} from "@/lib/proposals/store";
import {
  resolveAssistantItem,
  type AssistantMessageView,
} from "@/lib/assistant-service";
import { getStore } from "@/lib/store";
import type { WorkspaceScope } from "@/lib/store/types";

/**
 * Accepting or rejecting an edit the assistant proposed.
 *
 * ── What this file is now ──────────────────────────────────────────────────
 * An adapter. The claim, the guards, the permission checks and the apply all
 * live in `lib/proposals/`, shared with every other kind of agent deliverable.
 * What is left here is the part specific to a proposal made inside a
 * conversation: finding the right row from a message id, and shaping the
 * answer the panel expects.
 *
 * The rule the old implementation existed to enforce is unchanged and now
 * lives in `lib/proposals/handlers.ts`: nothing the assistant produces reaches
 * the repo without a human accepting it, and once accepted it travels the
 * exact same write path as a human edit.
 *
 * ── Why accepting is a `features` write, not an `assistant` one ────────────
 * The route lives under `/api/v1/features/{specId}/proposals`, so an API key
 * needs `features:write` to accept: the same grant that lets an integration
 * edit an item by hand. A key with only `assistant:write` can make the
 * assistant propose and cannot accept, which keeps "an agent may spend our
 * model budget" and "an agent may change our specs" as two separate decisions.
 * Granting both to one key does let an agent accept its own draft, and that is
 * the customer's call to make explicitly; what must not happen is it arriving
 * as a side effect of turning the assistant on.
 */

/**
 * The refusal reasons still come from here, because the routes import them
 * from here and moving a file should not be an API change.
 */
export {
  ProposalForbiddenError,
  ProposalInvalidError,
  ProposalNotFoundError,
  ProposalSettledError,
  ProposalStaleError,
  ProposalTooLongError,
} from "@/lib/proposals/errors";

interface ProposalResult {
  /** The turn as it now reads, so the panel can re-render from the answer. */
  message: AssistantMessageView;
  /** The subject's text after the change; unchanged text on a reject. */
  body: string;
  /** Where an accepted edit landed in git, when it landed there directly. */
  commitSha?: string;
  /**
   * Set when the repo takes spec changes as pull requests. The change is then
   * proposed to *git* and not yet live, which is a second review the person
   * who clicked accept has to be told about: the board still shows the old
   * text.
   */
  pullRequest?: { number: number; url: string; created: boolean };
  /** Other people's changes the accept merged with on its way in. */
  mergedWith?: number;
}

/** The turn, and what the old columns say was decided about it. */
interface LegacyTurn {
  content: string;
  authorId: string;
  model: string | null;
  createdAt: Date;
  outcome: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  commitSha: string | null;
  baseSha: string | null;
}

/**
 * Read the turn, scoped to the subject the URL named.
 *
 * By message id *and* by the feature or release the URL named, so a message
 * id from another thread cannot be resolved through a subject the caller
 * happens to have write access to. That check predates this refactor and is
 * why this does not simply look the message up by id.
 */
async function readTurn(
  db: Database,
  scope: WorkspaceScope,
  subject: { featureId: string } | { releaseId: string },
  messageId: string,
): Promise<LegacyTurn> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({
        content: assistantMessages.content,
        role: assistantMessages.role,
        authorId: assistantMessages.authorId,
        model: assistantMessages.model,
        createdAt: assistantMessages.createdAt,
        outcome: assistantMessages.proposalOutcome,
        resolvedBy: assistantMessages.proposalResolvedBy,
        resolvedAt: assistantMessages.proposalResolvedAt,
        commitSha: assistantMessages.proposalCommitSha,
        baseSha: assistantMessages.proposalBaseSha,
      })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.id, messageId),
          eq(assistantMessages.workspaceId, scope.workspaceId),
          "featureId" in subject
            ? eq(assistantMessages.featureId, subject.featureId)
            : eq(assistantMessages.releaseId, subject.releaseId),
        ),
      )
      .limit(1),
  );
  if (!row || row.role !== "assistant") {
    throw new ProposalNotFoundError("That proposal is no longer here.");
  }
  return row;
}

/** What the old outcome column means in the new lifecycle. */
function statusOf(outcome: string | null) {
  if (outcome === "accepted") return "applied" as const;
  if (outcome === "rejected") return "dismissed" as const;
  return "open" as const;
}

/**
 * The proposal row for a turn, creating it from the old columns if this turn
 * predates the table.
 *
 * ── Why materialise here rather than backfill in the migration ─────────────
 * Whether a message carries a proposal is decided by `parseAnswer`, whose
 * leniency is the whole point of it: it copes with the several ways a small
 * self-hosted model gets the marker block nearly right. Reimplementing that
 * grammar in SQL would create a second, silently diverging definition of what
 * a proposal is, and the divergence would show up as proposals that exist in
 * the panel and not in the queue.
 *
 * So the grammar stays in one place and the row is created the first time
 * somebody acts on the turn, which is the only moment it is needed. A turn
 * nobody ever decides about costs nothing.
 *
 * The decision comes across too. A proposal accepted last year must not become
 * acceptable again just because its row was written today.
 */
async function materialise(
  db: Database,
  scope: WorkspaceScope,
  turn: LegacyTurn,
  messageId: string,
  target: { type: "feature" | "release"; id: string; productId: string | null },
): Promise<ProposalRow> {
  const existing = await getProposalBySourceMessage(db, scope, messageId);
  if (existing) return existing;

  const { proposal } = parseAnswer(turn.content);
  if (!proposal) {
    throw new ProposalInvalidError("That message does not contain a proposal.");
  }

  const status = statusOf(turn.outcome);
  const created = await asUser(db, scope.userId, (tx) =>
    insertProposal(tx, {
      workspaceId: scope.workspaceId,
      productId: target.productId,
      origin: "conversation",
      sourceMessageId: messageId,
      actorId: turn.authorId,
      actorType: "user",
      kind: "spec_content",
      targetType: target.type,
      targetId: target.id,
      payload: { body: proposal },
      baseVersion: turn.baseSha,
      status,
      resolvedBy: turn.resolvedBy,
      // A settled row must carry a time (`proposals_resolution_ck`). An old
      // outcome with no timestamp falls back to when the turn was written:
      // wrong by hours, and a great deal more right than null would be.
      resolvedAt: status === "open" ? null : (turn.resolvedAt ?? turn.createdAt),
      result: turn.commitSha ? { commitSha: turn.commitSha } : null,
    }),
  );
  if (created) return created;

  // Lost the insert race against somebody clicking at the same moment. The
  // unique index on `source_message_id` turned that into a no-op, so the row
  // that won is the answer.
  const winner = await getProposalBySourceMessage(db, scope, messageId);
  if (!winner) {
    throw new ProposalNotFoundError("That proposal is no longer here.");
  }
  return winner;
}

/** The turn as it now reads, for the panel to swap in. */
function viewOf(
  turn: LegacyTurn,
  messageId: string,
  outcome: "accepted" | "rejected",
  resolvedAt: string,
  resolvedByName: string | null,
  commitSha: string | null,
): AssistantMessageView {
  return {
    id: messageId,
    role: "assistant",
    content: turn.content,
    authorId: turn.authorId,
    // Not resolved: the panel already holds the thread and only replaces the
    // one turn, so it keeps the author name it loaded. Looking it up again
    // would be a query to restore a value the caller never lost.
    authorName: null,
    model: turn.model,
    createdAt: turn.createdAt.toISOString(),
    // Answers carry no skill key: it is recorded on the question that asked
    // for them, which is what `activeSkill` reads.
    skillKey: null,
    proposal: { outcome, resolvedByName, resolvedAt, commitSha },
  };
}

/** The acting user's own name, for the decided-by line. */
async function actingName(
  db: Database,
  scope: WorkspaceScope,
): Promise<string | null> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, scope.userId))
      .limit(1),
  );
  return row?.name ?? null;
}

/** The item a thread hangs off, and the product the proposal row records. */
async function itemTarget(db: Database, scope: WorkspaceScope, specId: string) {
  const { feature, featureId } = await resolveAssistantItem(db, scope, specId);
  return {
    turnSubject: { featureId },
    target: {
      type: "feature" as const,
      id: featureId,
      productId: feature.productId,
    },
    currentBody: feature.content ?? "",
  };
}

/** The release a thread hangs off, resolved through the caller's own listing. */
async function releaseTarget(scope: WorkspaceScope, releaseId: string) {
  const store = await getStore();
  const release = (await store.listReleases(scope)).find(
    (r) => r.id === releaseId,
  );
  if (!release) {
    throw new ProposalNotFoundError("That release is no longer here.");
  }
  return {
    turnSubject: { releaseId },
    target: {
      type: "release" as const,
      id: release.id,
      productId: release.productId,
    },
    currentBody: release.releaseNotesBody ?? "",
  };
}

/**
 * Apply a proposal to the item.
 *
 * `body` overrides what the assistant drafted, which is what "edit before
 * accepting" is: the person read the diff, changed their mind about a line,
 * and what lands is their text. It is recorded as accepted either way,
 * because the question the record answers is "did a human decide this", and
 * they did. The item's own history holds what actually landed.
 */
export async function acceptProposal(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  messageId: string,
  opts: { body?: string } = {},
): Promise<ProposalResult> {
  const { turnSubject, target } = await itemTarget(db, scope, specId);
  const turn = await readTurn(db, scope, turnSubject, messageId);
  const row = await materialise(db, scope, turn, messageId, target);

  const { resolvedAt, outcome } = await applyProposal(db, scope, row.id, opts);
  const name = await actingName(db, scope);

  return {
    message: viewOf(
      turn,
      messageId,
      "accepted",
      resolvedAt,
      name,
      outcome.commitSha ?? null,
    ),
    body: outcome.body ?? "",
    ...(outcome.commitSha ? { commitSha: outcome.commitSha } : {}),
    ...(outcome.pullRequest ? { pullRequest: outcome.pullRequest } : {}),
    ...(outcome.mergedWith ? { mergedWith: outcome.mergedWith } : {}),
  };
}

/**
 * Turn a proposal down. Nothing is written to the item; the record of the
 * decision is the point.
 *
 * A rejected proposal is not deleted, and that is deliberate: the conversation
 * is how a colleague reconstructs why a definition says what it says, and "we
 * considered this wording and did not take it" is part of that. Deleting it
 * would leave a thread where the assistant appears to have been ignored.
 */
export async function rejectProposal(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  messageId: string,
): Promise<ProposalResult> {
  const { turnSubject, target, currentBody } = await itemTarget(
    db,
    scope,
    specId,
  );
  const turn = await readTurn(db, scope, turnSubject, messageId);
  const row = await materialise(db, scope, turn, messageId, target);

  const { resolvedAt } = await dismissProposal(db, scope, row.id);
  const name = await actingName(db, scope);
  return {
    message: viewOf(turn, messageId, "rejected", resolvedAt, name, null),
    body: currentBody,
  };
}

/** Apply a proposed change to a release's notes. */
export async function acceptReleaseProposal(
  db: Database,
  scope: WorkspaceScope,
  releaseId: string,
  messageId: string,
  opts: { body?: string } = {},
): Promise<ProposalResult> {
  const { turnSubject, target } = await releaseTarget(scope, releaseId);
  const turn = await readTurn(db, scope, turnSubject, messageId);
  const row = await materialise(db, scope, turn, messageId, target);

  const { resolvedAt, outcome } = await applyProposal(db, scope, row.id, opts);
  const name = await actingName(db, scope);
  return {
    message: viewOf(turn, messageId, "accepted", resolvedAt, name, null),
    body: outcome.body ?? "",
  };
}

/** Turn down a proposed change to a release's notes. Nothing is written. */
export async function rejectReleaseProposal(
  db: Database,
  scope: WorkspaceScope,
  releaseId: string,
  messageId: string,
): Promise<ProposalResult> {
  const { turnSubject, target, currentBody } = await releaseTarget(
    scope,
    releaseId,
  );
  const turn = await readTurn(db, scope, turnSubject, messageId);
  const row = await materialise(db, scope, turn, messageId, target);

  const { resolvedAt } = await dismissProposal(db, scope, row.id);
  const name = await actingName(db, scope);
  return {
    message: viewOf(turn, messageId, "rejected", resolvedAt, name, null),
    body: currentBody,
  };
}
