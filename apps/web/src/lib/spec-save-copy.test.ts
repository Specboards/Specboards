import { describe, expect, it } from "vitest";

import {
  saveButtonLabel,
  saveStatusLine,
  type SpecSaveState,
} from "@/lib/spec-save-copy";
import { notificationHeadline } from "@/lib/notification-copy";
import { snippetFor } from "@/lib/review-outcome-notify";
import type { NotificationRecord } from "@/lib/store/types";

/**
 * The vocabulary rule, enforced rather than intended.
 *
 * Putting an editor in the app and then telling a product manager their change
 * is on branch `specboard/spec-a1b2` awaiting review in PR #482 hands them back
 * the exact words they were trying to avoid. The feature would work and would
 * still be judged not to have solved the problem.
 *
 * So this asserts the absence of those words, not just the presence of nice
 * ones. Absence is the part that regresses: the next person to touch this copy
 * will be an engineer, to whom "commit" is the clearest available word.
 */

/** The nouns an author must never meet. `head`/`base` are matched as words. */
const ENGINEER_NOUNS =
  /\b(branch|branches|commit|commits|committed|committing|pull request|PR #|sha|base|head|repo|repository)\b/i;

function state(over: Partial<SpecSaveState> = {}): SpecSaveState {
  return {
    proposes: false,
    saving: false,
    dirty: false,
    proposed: false,
    saved: false,
    path: "specs/refunds/spec.md",
    ...over,
  };
}

/** Every state the editor can show, both write modes. */
const ALL_STATES: SpecSaveState[] = [false, true].flatMap((proposes) => [
  state({ proposes }),
  state({ proposes, dirty: true }),
  state({ proposes, saving: true }),
  state({ proposes, saved: true }),
  state({ proposes, proposed: true }),
]);

describe("the author never meets git vocabulary", () => {
  it("keeps it out of every save button label", () => {
    for (const s of ALL_STATES) {
      expect(saveButtonLabel(s)).not.toMatch(ENGINEER_NOUNS);
    }
  });

  it("keeps it out of every status line", () => {
    for (const s of ALL_STATES) {
      // The path is exempt: it names the document rather than the machinery,
      // and an author who cannot see which file they are editing is worse off.
      const withoutPath = saveStatusLine(s).replaceAll(s.path, "the spec");
      expect(withoutPath).not.toMatch(ENGINEER_NOUNS);
    }
  });

  it("keeps it out of what the inbox says about an outcome", () => {
    for (const type of ["spec_change_merged", "spec_change_closed"]) {
      const n = { type, actorName: null } as NotificationRecord;
      expect(notificationHeadline(n).text).not.toMatch(ENGINEER_NOUNS);
    }
    expect(snippetFor("merged", "Refunds", null)).not.toMatch(ENGINEER_NOUNS);
    expect(snippetFor("closed", "Refunds", null)).not.toMatch(ENGINEER_NOUNS);
  });
});

describe("what the copy does say", () => {
  it("warns before the save, not after, that review mode holds the change back", () => {
    // Said while the author still has unsaved work, because afterwards the
    // board showing the old text reads as a lost edit.
    expect(saveStatusLine(state({ proposes: true, dirty: true }))).toContain(
      "asks for a review",
    );
    expect(saveStatusLine(state({ proposes: true }))).toContain(
      "before they reach the board",
    );
  });

  it("explains why the board still shows the old text once a change is pending", () => {
    const line = saveStatusLine(state({ proposes: true, proposed: true }));
    expect(line).toContain("Waiting for review");
    expect(line).toContain("keeps its current text on the board");
  });

  it("says plainly that a direct save is already live", () => {
    expect(saveStatusLine(state({ saved: true }))).toContain("is live");
    expect(saveStatusLine(state({ dirty: true }))).toContain("straight away");
  });

  it("labels the action by what it does to the document", () => {
    expect(saveButtonLabel(state())).toBe("Save changes");
    expect(saveButtonLabel(state({ proposes: true }))).toBe("Send for review");
  });
});
