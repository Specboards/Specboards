import {
  and,
  assistantMessages,
  eq,
  isNull,
  users,
  type Database,
} from "@specboards/db";

import { asUser } from "@/lib/db-scope";

import { bodyFitsWhole } from "@/lib/ai/item-context";
import { parseAnswer } from "@/lib/ai/proposals";
import { notesFitWhole } from "@/lib/ai/release-context";
import {
  canEditItem,
  contentVersion,
  resolveAssistantItem,
  type AssistantMessageView,
} from "@/lib/assistant-service";
import { patchFeature } from "./features-service";
import { canEditRelease } from "@/lib/release-notes-service";
import { getStore } from "@/lib/store";
import { updateSpecContent } from "@/lib/spec-content";
import type {
  FeatureDetail,
  ReleaseRecord,
  WorkspaceScope,
} from "@/lib/store/types";

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

/**
 * The document is too long to have been sent to the model whole, so a rewrite
 * of it cannot be applied. Routes map to 422.
 *
 * The persist path already refuses to record such a proposal, so reaching this
 * means the document grew past the limit between the draft and the accept, or
 * the row predates that guard. Either way applying it would delete everything
 * past the cut, which is not a thing to do because of when it was drafted.
 */
export class ProposalTooLongError extends Error {}

/**
 * Refuse an accept whose document could not have been sent whole.
 *
 * Belt and braces beside the persist-time refusal in `persistTurns`, and not
 * redundant with it: an accept can happen a day later, and a description that
 * fitted when the draft was made may not fit now. The rule is one predicate
 * (`bodyFitsWhole` / `notesFitWhole`) used in three places, so the prompt, the
 * record and the accept cannot disagree about it.
 */
function assertSentWhole(fits: boolean, subject: "item" | "release"): void {
  if (fits) return;
  throw new ProposalTooLongError(
    subject === "item"
      ? "This item's description is too long to send to the model in full, so a " +
        "suggested rewrite cannot be applied: it would delete everything past " +
        "the point the assistant could see. Shorten the description, or edit it " +
        "directly."
      : "These release notes are too long to send to the model in full, so a " +
        "suggested rewrite cannot be applied: it would delete everything past " +
        "the point the assistant could see. Shorten the notes, or edit them " +
        "directly.",
  );
}

/**
 * The document moved after the proposal was drafted, so accepting it would
 * replace somebody's newer work. Routes map to 409, like a git write conflict.
 *
 * Carries the current body, because refusing without showing the new state only
 * moves the problem to the reviewer: they clicked Accept on a diff, and the
 * useful next step is seeing what it should have been a diff against.
 */
export class ProposalStaleError extends Error {
  constructor(
    message: string,
    readonly currentBody: string,
  ) {
    super(message);
    this.name = "ProposalStaleError";
  }
}

/**
 * Refuse an accept whose base no longer matches what is there now.
 *
 * A git-backed spec does not come through here: it has a blob sha and goes down
 * the guarded, merged write path instead, which can three-way merge rather than
 * simply refuse. This is for the two subjects that have no blob, where the only
 * honest options are "apply blindly" and "stop and show them" - and applying
 * blindly is what the audit found.
 *
 * `null` recorded means the proposal predates this guard. Those are allowed
 * through rather than refused: refusing would break every draft already sitting
 * on a card, to protect against a race that has probably not happened. New
 * drafts all carry a version.
 */
function assertNotStale(
  recordedBase: string | null,
  currentBody: string,
  subject: "item" | "release",
): void {
  if (recordedBase === null) return;
  if (recordedBase === contentVersion(currentBody)) return;
  throw new ProposalStaleError(
    subject === "item"
      ? "This item's description changed after the assistant drafted this, so " +
        "accepting would replace that newer version. Review the current text " +
        "and ask again if the change is still wanted."
      : "These release notes changed after the assistant drafted this, so " +
        "accepting would replace that newer version. Review the current notes " +
        "and ask again if the change is still wanted.",
    currentBody,
  );
}

interface ProposalResult {
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

  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
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
      .limit(1),
  );
  if (!row || row.role !== "assistant") {
    throw new ProposalNotFoundError("That proposal is no longer here.");
  }
  if (row.outcome) {
    // Named, because the useful thing to know is who got there first: the
    // second person to click is usually looking at a stale panel.
    const [who] = row.resolvedBy
      ? await asUser(db, scope.userId, (tx) =>
          tx
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, row.resolvedBy!))
            .limit(1),
        )
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
  const claimed = await asUser(db, scope.userId, (tx) =>
    tx
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
      .returning({ id: assistantMessages.id }),
  );
  if (claimed.length === 0) {
    throw new ProposalSettledError("Someone already decided about this proposal.");
  }
  return { resolvedAt: now };
}

/** Put a claim back when the write it was taken for did not happen. */
async function releaseClaim(
  db: Database,
  scope: WorkspaceScope,
  messageId: string,
): Promise<void> {
  await asUser(db, scope.userId, (tx) =>
    tx
      .update(assistantMessages)
      .set({
        proposalOutcome: null,
        proposalResolvedBy: null,
        proposalResolvedAt: null,
      })
      .where(eq(assistantMessages.id, messageId)),
  );
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
  const { row, who } = await asUser(db, scope.userId, async (tx) => {
    if (commitSha) {
      // Written after the commit exists rather than guessed before it: a sha on
      // a row that no commit matches is worse than no sha.
      await tx
        .update(assistantMessages)
        .set({ proposalCommitSha: commitSha })
        .where(eq(assistantMessages.id, messageId));
    }
    const [found] = await tx
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
    const [resolver] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, scope.userId))
      .limit(1);
    return { row: found, who: resolver };
  });
  if (!row) throw new ProposalNotFoundError("That proposal is no longer here.");

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
    // Answers carry no skill key: it is recorded on the question that asked for
    // them, which is what `activeSkill` reads.
    skillKey: null,
    proposal: {
      outcome,
      resolvedByName: who?.name ?? null,
      resolvedAt: resolvedAt.toISOString(),
      commitSha,
    },
  };
}

/**
 * The same load, for a proposal against a release's notes.
 *
 * A sibling rather than a branch, because the two differ in every line that
 * matters: which subject is resolved, which permission decides it, and which
 * column the message hangs off. What they share is everything after the
 * decision, and that is shared for real: {@link claim}, {@link release} and
 * {@link settled} take a message id and know nothing about subjects.
 */
async function loadReleaseProposal(
  db: Database,
  scope: WorkspaceScope,
  releaseId: string,
  messageId: string,
): Promise<{ release: ReleaseRecord; proposed: string; baseSha: string | null }> {
  const store = await getStore();
  const releases = await store.listReleases(scope);
  const release = releases.find((r) => r.id === releaseId);
  if (!release) throw new ProposalNotFoundError("That release is no longer here.");

  if (!(await canEditRelease(scope, release.productId))) {
    throw new ProposalForbiddenError(
      "Your role does not permit changing this release.",
    );
  }

  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
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
          // By the release the URL named as well as by id, so a message id from
          // another thread cannot be resolved through a release the caller
          // happens to have write access to.
          eq(assistantMessages.releaseId, releaseId),
        ),
      )
      .limit(1),
  );
  if (!row || row.role !== "assistant") {
    throw new ProposalNotFoundError("That proposal is no longer here.");
  }
  if (row.outcome) {
    const [who] = row.resolvedBy
      ? await asUser(db, scope.userId, (tx) =>
          tx
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, row.resolvedBy!))
            .limit(1),
        )
      : [];
    throw new ProposalSettledError(
      `${who?.name ?? "Someone"} already ${row.outcome} this proposal.`,
    );
  }

  const { proposal } = parseAnswer(row.content);
  if (!proposal) {
    throw new ProposalInvalidError("That message does not contain a proposal.");
  }
  return { release, proposed: proposal, baseSha: row.baseSha };
}

/** Turn down a proposed change to a release's notes. Nothing is written. */
export async function rejectReleaseProposal(
  db: Database,
  scope: WorkspaceScope,
  releaseId: string,
  messageId: string,
): Promise<ProposalResult> {
  const { release } = await loadReleaseProposal(db, scope, releaseId, messageId);
  const { resolvedAt } = await claim(db, scope, messageId, "rejected");
  return {
    message: await settled(db, scope, messageId, "rejected", resolvedAt, null),
    body: release.releaseNotesBody ?? "",
  };
}

/**
 * Apply a proposal to a release's notes.
 *
 * The write is `updateRelease`, which is the same call the editor makes when a
 * person types the notes themselves: same authorization, same validation, same
 * audit. There is no faster route from a model's output to the column, for the
 * reason this module opens with.
 *
 * ── How this is guarded ─────────────────────────────────────────────────────
 * A spec is guarded by its blob sha, because git gives us one. A release's
 * notes are a column with no version to point at, and this used to be left
 * unguarded on the reasoning that the notes are edited in one place and the
 * reviewer is looking at the diff when they click.
 *
 * Both halves of that turned out to be weaker than they read. "Edited in one
 * place" is a statement about habit rather than about the system, and the diff
 * the reviewer sees can itself be built from a stale browser copy, so the
 * mitigation could be describing a comparison against a version that is no
 * longer there. The base is now recorded as a content hash when the draft is
 * made and checked here, so a proposal drafted against text that has since
 * moved is refused rather than applied. See `assertNotStale`.
 *
 * Accepting also switches the notes on. A workspace with `releaseNotesMode` of
 * `none` that accepts a draft plainly means to have notes now, and leaving the
 * mode alone would apply the text and show nothing, which reads as the accept
 * having failed.
 */
export async function acceptReleaseProposal(
  db: Database,
  scope: WorkspaceScope,
  releaseId: string,
  messageId: string,
  opts: { body?: string } = {},
): Promise<ProposalResult> {
  const { release, proposed, baseSha } = await loadReleaseProposal(
    db,
    scope,
    releaseId,
    messageId,
  );
  const body = (opts.body ?? proposed).trim();
  if (!body) {
    throw new ProposalInvalidError(
      "An accepted proposal cannot be empty. Edit the notes directly to clear them.",
    );
  }

  // Before the claim, so a refused accept leaves the proposal actionable.
  assertNotStale(baseSha, release.releaseNotesBody ?? "", "release");
  assertSentWhole(notesFitWhole(release.releaseNotesBody), "release");

  const { resolvedAt } = await claim(db, scope, messageId, "accepted");

  const store = await getStore();
  try {
    await store.updateRelease(
      release.id,
      { releaseNotesMode: "in_app", releaseNotesBody: body },
      scope,
    );
  } catch (err) {
    // A refusal at the store leaves a proposal somebody can still act on,
    // rather than one marked accepted with nothing to show for it.
    await releaseClaim(db, scope, messageId);
    throw err;
  }

  return {
    message: await settled(db, scope, messageId, "accepted", resolvedAt, null),
    body,
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

  // Checked BEFORE the claim, so a refused accept leaves the proposal exactly
  // as it was rather than needing to be un-claimed. A spec skips this and is
  // guarded further down by its blob sha, which can merge rather than refuse.
  if (feature.isDbNative) {
    assertNotStale(baseSha, feature.content ?? "", "item");
  }
  // Applies to a spec as well as a card: a blob sha lets a merge resolve
  // *concurrent* edits, and says nothing about whether the model ever saw the
  // whole document.
  assertSentWhole(bodyFitsWhole(feature.content), "item");

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
      await releaseClaim(db, scope, messageId);
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
    await releaseClaim(db, scope, messageId);
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

