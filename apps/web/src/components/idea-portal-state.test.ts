import { describe, expect, it } from "vitest";

import {
  hasNotablePortalState,
  provenanceLine,
} from "@/components/idea-portal-state";
import type { IdeaRecord, PortalVisibility } from "@/lib/store/types";

/**
 * How the board says where an idea came from.
 *
 * The interesting case is the one the old code got wrong by omission rather
 * than by being wrong: `submitterName ?? authorName` renders NOTHING for an
 * anonymous external submission, because `authorId` is null on those rows too.
 * A moderator then sees a row with no provenance at all, which reads as an
 * ordinary internal capture nobody bothered to attribute, when it is in fact a
 * stranger's text about to be published under the company's branding. That is
 * the distinction this module exists to keep, so it is what these assert.
 */

function idea(over: Partial<IdeaRecord> = {}): IdeaRecord {
  return {
    id: "i1",
    title: "An idea",
    description: null,
    status: "new",
    portalVisibility: "published" as PortalVisibility,
    isExternalSubmission: false,
    productId: "p1",
    authorName: null,
    submitterName: null,
    voteCount: 0,
    viewerHasVoted: false,
    promotedFeatureSpecId: null,
    promotedFeatureTitle: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    ...over,
  };
}

describe("provenanceLine", () => {
  it("names an external submitter who gave a name", () => {
    expect(
      provenanceLine(
        idea({ isExternalSubmission: true, submitterName: "Ada" }),
      ),
    ).toBe("Submitted via the portal by Ada");
  });

  it("still says an anonymous submission came from the portal", () => {
    // The case the old fallback lost entirely. "Where did this come from" has
    // an answer here even though "who sent it" does not, and the first question
    // is the one a moderator is asking.
    expect(
      provenanceLine(idea({ isExternalSubmission: true, submitterName: null })),
    ).toBe("Submitted via the portal");
  });

  it("never attributes an external submission to an internal author", () => {
    // A row should not carry both, but the projection derives
    // `isExternalSubmission` from the email while `authorName` comes from a
    // join, so nothing structurally prevents it. Provenance is about the
    // outside/inside boundary, so the external answer wins rather than the
    // internal name being shown for a stranger's text.
    expect(
      provenanceLine(
        idea({
          isExternalSubmission: true,
          submitterName: null,
          authorName: "Internal Colleague",
        }),
      ),
    ).toBe("Submitted via the portal");
  });

  it("names an internal author for a capture", () => {
    expect(provenanceLine(idea({ authorName: "Bob" }))).toBe("Captured by Bob");
  });

  it("says nothing when an internal capture has no author", () => {
    // Rendering "Captured by " with a trailing space is worse than silence.
    expect(provenanceLine(idea())).toBeNull();
  });
});

describe("hasNotablePortalState", () => {
  it("is false for the default an untouched idea has", () => {
    // Every idea in a workspace with no portal is published and internal, so a
    // true here would put the Portal filter on every board in the product and
    // let it say only "all of them".
    expect(hasNotablePortalState(idea())).toBe(false);
  });

  it.each([["pending"], ["hidden"]] as const)(
    "is true once an idea is %s",
    (portalVisibility) => {
      expect(hasNotablePortalState(idea({ portalVisibility }))).toBe(true);
    },
  );

  it("is true for an external submission even once it is published", () => {
    // Publishing a submission does not stop it being one. The provenance chip
    // has to survive the moderation decision, or the board forgets which of
    // its rows a stranger wrote.
    expect(hasNotablePortalState(idea({ isExternalSubmission: true }))).toBe(
      true,
    );
  });
});
