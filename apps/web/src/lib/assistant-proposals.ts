import {
  and,
  assistantMessages,
  eq,
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

/** Stamp the decision on the message and return the turn as it now reads. */
async function settle(
  db: Database,
  scope: WorkspaceScope,
  messageId: string,
  outcome: "accepted" | "rejected",
  commitSha: string | null,
): Promise<AssistantMessageView> {
  const now = new Date();
  const [updated] = await db
    .update(assistantMessages)
    .set({
      proposalOutcome: outcome,
      proposalResolvedBy: scope.userId,
      proposalResolvedAt: now,
      proposalCommitSha: commitSha,
    })
    .where(eq(assistantMessages.id, messageId))
    .returning();
  if (!updated) throw new ProposalNotFoundError("That proposal is no longer here.");

  const [who] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, scope.userId))
    .limit(1);

  return {
    id: updated.id,
    role: "assistant",
    content: updated.content,
    authorId: updated.authorId,
    // Not resolved: the panel already holds the thread and only replaces the
    // one turn, so it keeps the author name it loaded. Looking it up again
    // would be a query to restore a value the caller never lost.
    authorName: null,
    model: updated.model,
    createdAt: updated.createdAt.toISOString(),
    proposal: {
      outcome,
      resolvedByName: who?.name ?? null,
      resolvedAt: now.toISOString(),
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
  return {
    message: await settle(db, scope, messageId, "rejected", null),
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

  if (feature.isDbNative) {
    // A card's body is a database column, so the human path is the ordinary
    // patch and so is this one. `patchFeature` does its own product-write check
    // and writes the change ledger, which is where the item's history of this
    // edit comes from.
    await patchFeature(specId, { details: body }, scope);
    return {
      message: await settle(db, scope, messageId, "accepted", null),
      body,
    };
  }

  const result = await updateSpecContent(db, scope, specId, body, {
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

  return {
    message: await settle(db, scope, messageId, "accepted", result.commitSha),
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

