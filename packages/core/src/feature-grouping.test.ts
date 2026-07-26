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
