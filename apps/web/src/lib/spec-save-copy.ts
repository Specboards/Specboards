/**
 * What the spec editor says about saving.
 *
 * Kept out of the component so it can be tested, and so the rule it follows can
 * be enforced rather than just intended: an author reading these strings should
 * never meet a branch, a commit, a pull request, a base, a head or a sha. Those
 * are engineer nouns, and handing them to the person this whole flow exists to
 * spare is how a feature that works is still judged not to have solved the
 * problem.
 *
 * The mechanism is not hidden, it is demoted. The commit is in the status
 * line's tooltip and the review is a link, so anyone who wants the underlying
 * thing can reach it in one move. What the copy leads with is what the author
 * actually needs to know: whether their words are live yet, and if not, what
 * they are waiting for.
 */

/** Everything the copy depends on. */
export interface SpecSaveState {
  /** True when saving proposes a change for review instead of publishing it. */
  proposes: boolean;
  saving: boolean;
  /** Unsaved edits in the editor. */
  dirty: boolean;
  /** A proposal from this session is open and waiting for review. */
  proposed: boolean;
  /** A save in this session has already landed. */
  saved: boolean;
  /** Repo-relative path of the spec file. Names the document, so it stays. */
  path: string;
}

export function saveButtonLabel(s: SpecSaveState): string {
  if (s.saving) return s.proposes ? "Sending…" : "Saving…";
  return s.proposes ? "Send for review" : "Save changes";
}

export function saveStatusLine(s: SpecSaveState): string {
  if (s.saving) {
    return s.proposes ? `Proposing a change to ${s.path}…` : `Saving ${s.path}…`;
  }
  if (s.dirty) {
    return s.proposes
      ? `Unsaved changes. Sending asks for a review of ${s.path}.`
      : `Unsaved changes. Saving publishes ${s.path} straight away.`;
  }
  if (s.proposed) {
    // The single most important sentence in review mode. The board goes on
    // showing the old text after a save, and an author who was not told that
    // reads it as their edit having been thrown away.
    return `Waiting for review. ${s.path} keeps its current text on the board until this is approved.`;
  }
  if (s.saved) return `Saved. ${s.path} is live.`;
  return s.proposes
    ? `Changes to ${s.path} go for review before they reach the board.`
    : `Changes to ${s.path} go live as soon as you save.`;
}
