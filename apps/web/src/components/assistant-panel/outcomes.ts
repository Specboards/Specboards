import type { ProposalOutcome } from "@/lib/api-client/assistant";
import { ProposalStaleError, SpecConflictError } from "@/lib/api-client/specs";
import type { AssistantMessageView } from "@/lib/assistant-service";

import { assistantErrorAdvice } from "./advice";
import type { AssistantSubject } from "./subject";
import { subjectBodyNoun, subjectNoun } from "./subject";

/**
 * What each thing that can come back from the assistant means for the page.
 *
 * These were branches inside two long async methods, which is a bad place for
 * them: the branch that matters most is the one that must *not* refresh, and a
 * branch that fails by doing nothing visible is exactly the kind that survives
 * review. Accepting a proposal that went to a pull request changes nothing on
 * the default branch, so refetching would redraw the old text and read as if
 * the accept had failed.
 *
 * Each function returns a description of what should happen. Performing it,
 * in order, is the caller's job.
 */

type TurnResult =
  | { kind: "landed"; turns: AssistantMessageView[] }
  | { kind: "cancelled" }
  | { kind: "failed"; advice: { text: string; settingsLink: boolean } };

/**
 * What a finished turn means.
 *
 * Cancelling is not a failure and gets no error panel. The partial answer is
 * dropped rather than left on screen, because the server stored nothing:
 * showing it would imply a turn that does not exist and would vanish on the
 * next reload anyway.
 */
export function turnResult(
  outcome:
    | { ok: true; turns: AssistantMessageView[] }
    | { ok: false; error: { kind: string; message: string } }
    | { ok: false; cancelled: true },
): TurnResult {
  if (outcome.ok) return { kind: "landed", turns: outcome.turns };
  if ("cancelled" in outcome) return { kind: "cancelled" };
  return {
    kind: "failed",
    advice: assistantErrorAdvice(outcome.error.kind, outcome.error.message),
  };
}

/** What accepting or rejecting a proposal means for the rest of the page. */
interface ResolutionEffect {
  /**
   * The body to hand back to the host so it can reseed its editor, or null to
   * leave it alone.
   *
   * Applied before anything else. The description editor above the panel owns
   * its content once mounted and never reseeds, so after an accept it is
   * holding the old body, and the next character typed into it autosaves that
   * old body back over the change just applied.
   */
  reseedHost: string | null;
  toast: string;
  /**
   * Whether the server-rendered description elsewhere on the page has to be
   * refetched. False when nothing on the default branch changed.
   */
  refresh: boolean;
}

export function resolutionEffect(
  action: "accept" | "reject",
  outcome: ProposalOutcome,
  subject: AssistantSubject,
): ResolutionEffect {
  if (action === "reject") {
    return { reseedHost: null, toast: "Left as it is.", refresh: false };
  }
  if (outcome.pullRequest) {
    // The change is waiting for review, so there is nothing to reseed and
    // nothing to refetch.
    return {
      reseedHost: null,
      toast: outcome.pullRequest.created
        ? `Sent for review as #${outcome.pullRequest.number}`
        : `Added to review #${outcome.pullRequest.number}`,
      refresh: false,
    };
  }
  return {
    reseedHost: outcome.body,
    toast: outcome.mergedWith
      ? "Applied, and merged with a change made in the meantime."
      : `Applied to the ${subjectNoun(subject)}.`,
    refresh: true,
  };
}

/** What a failed resolution should say, and what the diff should compare against. */
interface ResolutionFailure {
  message: string;
  /** The text that won, to redraw the diff against, or null if unknown. */
  body: string | null;
}

/**
 * Explain a resolution that did not go through.
 *
 * The two named errors are the same shape and are handled the same way for the
 * same reason: the proposal stays open, because it was not applied and a card
 * claiming otherwise is worse than the error, and the diff is redrawn against
 * the text that won. Telling a reviewer their base is gone while still showing
 * them that base is the stale-diff problem the guard exists to close rather
 * than a smaller version of it.
 */
export function resolutionFailure(
  err: unknown,
  subject: AssistantSubject,
): ResolutionFailure {
  if (err instanceof SpecConflictError) {
    return {
      message:
        `${err.message} Open the description and edit it there, or ask the ` +
        "assistant again now that the spec has moved.",
      body: err.conflict.currentContent,
    };
  }
  if (err instanceof ProposalStaleError) {
    return {
      message:
        `${err.message} The diff below now compares against the current ` +
        `${subjectBodyNoun(subject)}.`,
      body: err.currentBody,
    };
  }
  return {
    message: err instanceof Error ? err.message : "That did not go through.",
    body: null,
  };
}
