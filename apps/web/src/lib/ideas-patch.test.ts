import { describe, expect, it } from "vitest";

import { parseIdeaPatch } from "@/lib/ideas-service";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * The moderation field arrives over HTTP, so it is parsed rather than trusted.
 *
 * `portal_visibility` is constrained by a CHECK in the database (0012), which
 * means an unvalidated value does not corrupt anything: it raises. But it
 * raises as a constraint violation from deep in the store, which surfaces as a
 * 500 and tells the caller nothing about what it should have sent. Validating
 * here turns that into a 422 naming the three states, which is the difference
 * between an error somebody can act on and one they file a bug about.
 */
describe("parseIdeaPatch: portalVisibility", () => {
  it.each([["published"], ["pending"], ["hidden"]])(
    "accepts %s",
    (portalVisibility) => {
      expect(parseIdeaPatch({ portalVisibility })).toEqual({
        portalVisibility,
      });
    },
  );

  it.each([
    ["a state that does not exist", "deleted"],
    ["the empty string", ""],
    ["a near miss in case", "Published"],
    ["a boolean", true],
    ["null, which is not the same as absent", null],
  ])("rejects %s", (_label, portalVisibility) => {
    expect(() => parseIdeaPatch({ portalVisibility })).toThrow(
      InvalidPatchError,
    );
  });

  it("names the accepted values, so a caller can fix the request", () => {
    expect(() => parseIdeaPatch({ portalVisibility: "nope" })).toThrow(
      /published, pending, hidden/,
    );
  });

  it("leaves the field alone when the key is absent", () => {
    // Absent is not the same as unchanged-to-published. A patch that set every
    // idea it touched back to published would silently un-hide things whenever
    // somebody edited a title.
    expect(parseIdeaPatch({ title: "New title" })).toEqual({
      title: "New title",
    });
  });

  it("counts as a patch on its own", () => {
    // Publishing is usually the ONLY thing a moderator changes, so it has to
    // satisfy the at-least-one-field rule by itself.
    expect(() => parseIdeaPatch({ portalVisibility: "published" })).not.toThrow();
  });
});
