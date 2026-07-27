import { describe, expect, it } from "vitest";

import { featureTitleFor, isGeneratedGroupingTitle } from "./feature-grouping.js";

describe("featureTitleFor", () => {
  it("titles a folder-derived grouping from its last path segment", () => {
    // The exact shape from the customer report: create_spec writes each spec to
    // specs/<slug>/spec.md, so the grouping key is the folder.
    expect(
      featureTitleFor(
        "path:specs/per-scope-checkboxes-on-the-mcp-consent-screen",
        "fallback",
      ),
    ).toBe("Per Scope Checkboxes On The Mcp Consent Screen");
  });

  it("uses a declared feature: value verbatim, only cleaning separators", () => {
    expect(featureTitleFor("feature:checkout-flow", "fallback")).toBe(
      "Checkout Flow",
    );
    // Casing the author chose is preserved where it is already uppercase.
    expect(featureTitleFor("feature:SMTP transport", "fallback")).toBe(
      "SMTP Transport",
    );
  });

  it("collapses runs of separators into one space", () => {
    expect(featureTitleFor("path:specs/a--b__c", "fallback")).toBe("A B C");
  });

  /**
   * The customer's second reported title carried a double space, which
   * featureSlug cannot produce: it maps every run of non-alphanumerics to a
   * single hyphen. So the key came from somewhere else, a hand-authored
   * `feature:` value or a folder name with a space in it, and a space adjacent to
   * a hyphen turned into two spaces. Whitespace now collapses with the
   * separators.
   */
  it("collapses whitespace next to a separator, not just the separators", () => {
    const expected = "Smtp Transport In Palouse Mail Mailpit In The E2e Stack";
    for (const key of [
      "path:specs/smtp-transport-in-palouse-mail -mailpit-in-the-e2e-stack",
      "path:specs/smtp-transport-in-palouse-mail- mailpit-in-the-e2e-stack",
      "feature:smtp-transport-in-palouse-mail  mailpit-in-the-e2e-stack",
    ]) {
      expect(featureTitleFor(key, "fallback")).toBe(expected);
    }
  });

  it("falls back when the key is only whitespace", () => {
    expect(featureTitleFor("feature:   ", "Spec Title")).toBe("Spec Title");
  });

  it("falls back for a spec: key, which carries only a uuid", () => {
    expect(featureTitleFor("spec:0f8e-1234", "Spec Title")).toBe("Spec Title");
  });

  it("falls back when the key yields nothing usable", () => {
    expect(featureTitleFor("path:specs/---", "Spec Title")).toBe("Spec Title");
  });
});

/**
 * isGeneratedGroupingTitle gates deletion of an abandoned grouping, so a false
 * positive would delete a card someone had adopted. It must only say "yes" when
 * the title is exactly what sync would have produced.
 */
describe("isGeneratedGroupingTitle", () => {
  it("recognises an untouched generated title", () => {
    expect(
      isGeneratedGroupingTitle("path:specs/checkout", "Checkout"),
    ).toBe(true);
  });

  it("rejects a title the user renamed", () => {
    expect(
      isGeneratedGroupingTitle("path:specs/checkout", "Checkout (Q3 push)"),
    ).toBe(false);
    expect(isGeneratedGroupingTitle("path:specs/checkout", "Payments")).toBe(
      false,
    );
  });

  /**
   * A grouping created before whitespace collapsed keeps its double-spaced title,
   * which no longer matches what the helper generates. That row therefore counts
   * as "touched" and is kept rather than pruned, which is the safe direction: the
   * fix must never turn into a licence to delete older cards.
   */
  it("treats a pre-existing double-spaced title as not generated", () => {
    expect(
      isGeneratedGroupingTitle(
        "path:specs/palouse-mail -mailpit",
        "Palouse Mail  Mailpit",
      ),
    ).toBe(false);
    expect(
      isGeneratedGroupingTitle(
        "path:specs/palouse-mail -mailpit",
        "Palouse Mail Mailpit",
      ),
    ).toBe(true);
  });

  it("is case- and space-sensitive", () => {
    expect(isGeneratedGroupingTitle("path:specs/checkout", "checkout")).toBe(
      false,
    );
    expect(isGeneratedGroupingTitle("path:specs/checkout", " Checkout")).toBe(
      false,
    );
  });

  it("refuses a spec: key, whose title is not derivable", () => {
    // The generated title would have fallen back to the spec's own title, which
    // cannot be reconstructed from the key. Keeping the card is the safe answer.
    expect(isGeneratedGroupingTitle("spec:0f8e-1234", "Anything")).toBe(false);
    expect(isGeneratedGroupingTitle("spec:0f8e-1234", "")).toBe(false);
  });

  it("refuses an empty title", () => {
    expect(isGeneratedGroupingTitle("path:specs/checkout", "")).toBe(false);
  });
});
