/**
 * Why a proposal could not be acted on.
 *
 * Moved here from `lib/assistant-proposals.ts` when proposals became a table
 * of their own, so the assistant path and the harness path refuse things for
 * the same reasons with the same words. `assistant-proposals.ts` re-exports
 * them, which is why the existing routes did not have to change.
 *
 * The HTTP mapping each one carries is part of the contract, not a hint: the
 * difference between a 409 and a 422 is the difference between "try again once
 * the collision is sorted" and "retrying changes nothing".
 */

/** No such proposal, or the caller cannot see its target. Routes map to 404. */
export class ProposalNotFoundError extends Error {}

/** The payload is unreadable or empty. Routes map to 422. */
export class ProposalInvalidError extends Error {}

/** Somebody already decided about it. Routes map to 409. */
export class ProposalSettledError extends Error {}

/** The caller may read the target but not change it. Routes map to 403. */
export class ProposalForbiddenError extends Error {}

/**
 * The document is too long to have been sent to the model whole, so a rewrite
 * of it cannot be applied. Routes map to 422.
 *
 * Reaching this means the document grew past the limit between the draft and
 * the apply, or the row predates the guard. Either way applying it would
 * delete everything past the cut, which is not a thing to do because of when
 * it was drafted.
 */
export class ProposalTooLongError extends Error {}

/**
 * The target moved after the proposal was drafted, so applying it would
 * replace somebody's newer work. Routes map to 409, like a git write conflict.
 *
 * Carries the current body, because refusing without showing the new state
 * only moves the problem to the reviewer: they clicked Apply on a diff, and
 * the useful next step is seeing what it should have been a diff against.
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
