import {
  and,
  assistantMessages,
  eq,
  isNull,
  users,
  type Database,
} from "@specboards/db";

import { parseAnswer } from "@/lib/ai/proposals";
import {
  canEditItem,
  resolveAssistantItem,
  type AssistantMessageView,
} from "@/lib/assistant-service";
import { patchFeature } from "@/lib/features-service";
import { updateSpecContent } from "@/lib/spec-content";
import type { FeatureDetail, WorkspaceScope } from "@/lib/store/types";

/**
 * Accepting or rejecting an edit the assistant proposed.
 *
 * ── The rule this module exists to enforce ──────────────────────────────────
 * Nothing the assistant produces reaches the repo without a human accepting it,
 * and once accepted it travels the exact same write path as a human edit: same
 * authorization, same write mode, same conflict guard, same pull request.
 *
 * That is why {@link acceptProposal} calls `updateSpecContent` and
 * `patchFeature` rather than writing anything itself. There is no faster route
 * and no privileged one. A proposal accepted on a repo in pull-request mode
 * becomes a pull request, exactly as an author's own save would, because it *is*
 * an author's own save: the text was drafted by a model and the decision was
 * made by a person, and the write path only ever sees the decision.
 *
 * The shortcut worth naming, because it is genuinely tempting: this module
 * already holds the proposed body and the item, so it could write to git
 * directly and skip a permission check and two round trips. Doing that would
 * create a second way to change a spec, one that no review, audit record or
 * write-mode setting applies to, and nobody would notice until it mattered.
 *
 * ── Why accepting is a `features` write, not an `assistant` one ─────────────
 * The route lives under `/api/v1/features/{specId}/proposals`, so an API key
 * needs `features:write` to accept: the same grant that lets an integration edit
 * an item by hand. A key with only `assistant:write` can make the assistant
 * propose and cannot accept, which keeps "an agent may spend our model budget"
 * and "an agent may change our specs" as two separate decisions. Granting both
 * to one key does let an agent accept its own draft, and that is the customer's
 * call to make explicitly; what must not happen is it arriving as a side effect
 * of turning the assistant on.
 */

/** No such message, or the caller cannot see the item. Routes map to 404. */
export class ProposalNotFoundError extends Error {}
/** The message carries no proposal, or the replacement body is empty. 422. */
export class ProposalInvalidError extends Error {}
/** Somebody already accepted or rejected it. Routes map to 409. */
export class ProposalSettledError extends Error {}
/** The caller may read the item but not change it. Routes map to 403. */
export class ProposalForbiddenError extends Error {}

export interface ProposalResult {
  /** The turn as it now reads, so the panel can re-render from the answer. */
  message: AssistantMessageView;
  /** The item's description after the change; unchanged text on a reject. */
  body: string;
  /** Where an accepted edit landed in git, when it landed there directly. */
  commitSha?: string;
  /**
   * Set when the repo takes spec changes as pull requests. The change is then
   * proposed to *git* and not yet live, which is a second review the person who
   * clicked accept has to be told about: the board still shows the old text.
   */
  pullRequest?: { number: number; url: string; created: boolean };
  /** Other people's changes the accept merged with on its way in. */
  mergedWith?: number;
}

/**
 * Load a proposal and everything needed to decide about it, refusing anyone who
 * may not act on it.
 *
 * The message is looked up by id *and* by the feature the URL named, so a
 * message id from another item cannot be resolved through an item the caller
 * happens to have write access to.
 */
async function loadProposal(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  messageId: string,
): Promise<{ feature: FeatureDetail; proposed: string; baseSha: string | null }> {
  const { feature, featureId } = await resolveAssistantItem(db, scope, specId);
  if (!(await canEditItem(scope, feature))) {
    throw new ProposalForbiddenError(
      "Your role does not permit changing this item.",
    );
  }

  const [row] = await db
    .select({
      content: assistantMessages.content,
      role: assistantMessages.role,
      outcome: assistantMessages.proposalOutcome,
      resolvedBy: assistantMessages.proposalResolvedBy,
      baseSha: assistantMessages.proposalBaseSha,
    })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.workspaceId, scope.workspaceId),
        eq(assistantMessages.featureId, featureId),
      ),
    )
    .limit(1);
  if (!row || row.role !== "assistant") {
    throw new ProposalNotFoundError("That proposal is no longer here.");
  }
  if (row.outcome) {
    // Named, because the useful thing to know is who got there first: the
    // second person to click is usually looking at a stale panel.
    const [who] = row.resolvedBy
      ? await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, row.resolvedBy))
          .limit(1)
      : [];
    throw new ProposalSettledError(
      `${who?.name ?? "Someone"} already ${row.outcome} this proposal.`,
    );
  }

  const { proposal } = parseAnswer(row.content);
  if (!proposal) {
    throw new ProposalInvalidError("That message does not contain a proposal.");
  }
  return { feature, proposed: proposal, baseSha: row.baseSha };
}

/**
 * Take the decision, atomically, *before* anything is applied.
 *
 * The check in {@link loadProposal} is for the message it produces, not for
 * safety: between reading the row and writing to the item, a second request
 * (two people with the panel open, or one person double-clicking Accept) can do
 * the whole thing too, and the item gets written twice. A conditional update is
 * the only operation here that is atomic, so it is what decides who won, and it
 * runs first. If the write then fails the claim is released, which is why this
 * is a claim rather than a record.
 */
async function claim(
  db: Database,
  scope: WorkspaceScope,
  messageId: string,
  outcome: "accepted" | "rejected",
): Promise<{ resolvedAt: Date }> {
  const now = new Date();
  const claimed = await db
    .update(assistantMessages)
    .set({
      proposalOutcome: outcome,
      proposalResolvedBy: scope.userId,
      proposalResolvedAt: now,
    })
    .where(
      and(
        eq(assistantMessages.id, messageId),
        // The whole guard. Anything already decided is not ours to decide.
        isNull(assistantMessages.proposalOutcome),
      ),
    )
    .returning({ id: assistantMessages.id });
  if (claimed.length === 0) {
    throw new ProposalSettledError("Someone already decided about this proposal.");
  }
  return { resolvedAt: now };
}

/** Put a claim back when the write it was taken for did not happen. */
async function release(db: Database, messageId: string): Promise<void> {
  await db
    .update(assistantMessages)
    .set({
      proposalOutcome: null,
      proposalResolvedBy: null,
      proposalResolvedAt: null,
    })
    .where(eq(assistantMessages.id, messageId));
}

/** The turn as it now reads, for the panel to swap in. */
async function settled(
  db: Database,
  scope: WorkspaceScope,
  messageId: string,
  outcome: "accepted" | "rejected",
  resolvedAt: Date,
  commitSha: string | null,
): Promise<AssistantMessageView> {
  if (commitSha) {
    // Written after the commit exists rather than guessed before it: a sha on a
    // row that no commit matches is worse than no sha.
    await db
      .update(assistantMessages)
      .set({ proposalCommitSha: commitSha })
      .where(eq(assistantMessages.id, messageId));
  }
  const [row] = await db
    .select({
      id: assistantMessages.id,
      content: assistantMessages.content,
      authorId: assistantMessages.authorId,
      model: assistantMessages.model,
      createdAt: assistantMessages.createdAt,
    })
    .from(assistantMessages)
    .where(eq(assistantMessages.id, messageId))
    .limit(1);
  if (!row) throw new ProposalNotFoundError("That proposal is no longer here.");

  const [who] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, scope.userId))
    .limit(1);

  return {
    id: row.id,
    role: "assistant",
    content: row.content,
    authorId: row.authorId,
    // Not resolved: the panel already holds the thread and only replaces the
    // one turn, so it keeps the author name it loaded. Looking it up again
    // would be a query to restore a value the caller never lost.
    authorName: null,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    proposal: {
      outcome,
      resolvedByName: who?.name ?? null,
      resolvedAt: resolvedAt.toISOString(),
      commitSha,
    },
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
  const { feature } = await loadProposal(db, scope, specId, messageId);
  const { resolvedAt } = await claim(db, scope, messageId, "rejected");
  return {
    message: await settled(db, scope, messageId, "rejected", resolvedAt, null),
    body: feature.content,
  };
}

/**
 * Apply a proposal to the item.
 *
 * `body` overrides what the assistant drafted, which is what "edit before
 * accepting" is: the person read the diff, changed their mind about a line, and
 * what lands is their text. It is recorded as accepted either way, because the
 * question the record answers is "did a human decide this", and they did. The
 * item's own history holds what actually landed.
 */
export async function acceptProposal(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  messageId: string,
  opts: { body?: string } = {},
): Promise<ProposalResult> {
  const { feature, proposed, baseSha } = await loadProposal(
    db,
    scope,
    specId,
    messageId,
  );
  const body = (opts.body ?? proposed).trim();
  if (!body) {
    // Emptying an item's description is a legitimate thing for a person to do,
    // but not through this door and not as the outcome of clicking Accept.
    throw new ProposalInvalidError(
      "An accepted proposal cannot be empty. Edit the item directly to clear it.",
    );
  }

  // Claimed before the write, so a double-click cannot apply the same text
  // twice. Released if the write does not happen, so a refusal at the repo
  // leaves a proposal somebody can still act on rather than one marked
  // accepted with nothing to show for it.
  const { resolvedAt } = await claim(db, scope, messageId, "accepted");

  if (feature.isDbNative) {
    // A card's body is a database column, so the human path is the ordinary
    // patch and so is this one. `patchFeature` does its own product-write check
    // and writes the change ledger, which is where the item's history of this
    // edit comes from.
    try {
      await patchFeature(specId, { details: body }, scope);
    } catch (err) {
      await release(db, messageId);
      throw err;
    }
    return {
      message: await settled(db, scope, messageId, "accepted", resolvedAt, null),
      body,
    };
  }

  let result;
  try {
    result = await updateSpecContent(db, scope, specId, body, {
      // Not a pre-built message: the write path decides whether the acting user
      // also needs a co-author trailer, which depends on whose token authors the
      // commit, and that is not knowable here.
      assistantDrafted: true,
      // Guarded against the version the model was shown, not against whatever is
      // there now. A spec someone edited in the meantime is merged with, exactly
      // as it would be for a human whose editor had been open that long, and only
      // a genuine overlap is refused.
      ...(baseSha ? { expectedBlobSha: baseSha } : {}),
    });
  } catch (err) {
    // Most importantly a conflict: the reviewer has to be able to come back to
    // this proposal once the collision is sorted out.
    await release(db, messageId);
    throw err;
  }

  return {
    message: await settled(
      db,
      scope,
      messageId,
      "accepted",
      resolvedAt,
      result.commitSha,
    ),
    body: result.mergedBody ?? body,
    commitSha: result.commitSha,
    ...(result.pullRequest
      ? {
          pullRequest: {
            number: result.pullRequest.number,
            url: result.pullRequest.url,
            created: result.pullRequest.created,
          },
        }
      : {}),
    ...(result.mergedWith ? { mergedWith: result.mergedWith } : {}),
  };
}

