import { describe, expect, it } from "vitest";

import {
  assembleReleaseContext,
  ITEM_LIST_CHAR_LIMIT,
  type ReleaseContextGroup,
} from "./release-context";

/** A release with one epic and one feature, the ordinary case. */
function input(overrides: Partial<Parameters<typeof assembleReleaseContext>[0]> = {}) {
  return {
    name: "v1.4.0",
    statusLabel: "In progress",
    targetDate: "2026-09-01",
    shippedDate: null,
    groups: [
      {
        levelLabel: "Epic",
        items: [{ title: "Single sign-on", statusLabel: "Done" }],
      },
      {
        levelLabel: "Feature",
        items: [{ title: "SAML metadata upload", statusLabel: "In review" }],
      },
    ] as ReleaseContextGroup[],
    ...overrides,
  };
}

describe("assembleReleaseContext", () => {
  it("builds the prompt from the disclosed fields and nothing else", () => {
    const { systemPrompt, fields } = assembleReleaseContext(input());

    // The claim the whole disclosure rests on: every field is in the prompt.
    for (const field of fields) {
      expect(systemPrompt).toContain(field.value);
    }
    expect(fields.map((f) => f.label)).toEqual([
      "Release",
      "Status",
      "Target date",
      "Work in this release",
    ]);
  });

  it("names the audience and forbids claiming a save", () => {
    const { systemPrompt } = assembleReleaseContext(input());
    expect(systemPrompt).toContain("customer-facing release notes");
    expect(systemPrompt).toContain("You cannot change anything.");
    expect(systemPrompt).toContain("Never claim to have saved");
  });

  it("counts every item it included", () => {
    const assembled = assembleReleaseContext(input());
    expect(assembled.itemsIncluded).toBe(2);
    expect(assembled.itemsOmitted).toBe(0);
  });

  it("groups items under their own level's label", () => {
    const { systemPrompt } = assembleReleaseContext(input());
    expect(systemPrompt).toContain("Epic:\n- Single sign-on (Done)");
    expect(systemPrompt).toContain("Feature:\n- SAML metadata upload (In review)");
  });

  it("prefers the shipped date over the target date", () => {
    const { fields } = assembleReleaseContext(
      input({ shippedDate: "2026-08-30", targetDate: "2026-09-01" }),
    );
    expect(fields.find((f) => f.label === "Shipped")?.value).toBe("2026-08-30");
    expect(fields.some((f) => f.label === "Target date")).toBe(false);
  });

  it("omits a date field entirely when the release has neither", () => {
    const { fields, systemPrompt } = assembleReleaseContext(
      input({ shippedDate: null, targetDate: null }),
    );
    // Not sent as "none": a disclosure line claiming we sent something we did
    // not is worse than a missing one.
    expect(fields.some((f) => f.label === "Shipped")).toBe(false);
    expect(fields.some((f) => f.label === "Target date")).toBe(false);
    expect(systemPrompt).not.toContain("none");
  });

  it("sends no item list when the release holds nothing", () => {
    const assembled = assembleReleaseContext(input({ groups: [] }));
    expect(assembled.itemsIncluded).toBe(0);
    expect(
      assembled.fields.some((f) => f.label === "Work in this release"),
    ).toBe(false);
  });

  describe("when the release is too big to send whole", () => {
    const many: ReleaseContextGroup[] = [
      {
        levelLabel: "Epic",
        items: Array.from({ length: 5 }, (_, i) => ({
          title: `Epic number ${i}`,
          statusLabel: "Done",
        })),
      },
      {
        levelLabel: "Work Item",
        items: Array.from({ length: 400 }, (_, i) => ({
          title: `A work item with a reasonably long title, number ${i}`,
          statusLabel: "Done",
        })),
      },
    ];

    it("keeps the top of the release and reports what it dropped", () => {
      const assembled = assembleReleaseContext(input({ groups: many }));

      expect(assembled.itemsOmitted).toBeGreaterThan(0);
      expect(assembled.itemsIncluded + assembled.itemsOmitted).toBe(405);
      // Cut level by level in hierarchy order, so the epics survive: a release
      // too big to send is better described by its top than by an arbitrary
      // slice of its leaves.
      expect(assembled.systemPrompt).toContain("Epic number 4");
    });

    it("stays inside the budget", () => {
      const { fields } = assembleReleaseContext(input({ groups: many }));
      const list = fields.find((f) => f.label === "Work in this release");
      expect(list?.value.length).toBeLessThanOrEqual(ITEM_LIST_CHAR_LIMIT);
    });

    it("cuts on whole items, never mid-title", () => {
      const { fields } = assembleReleaseContext(input({ groups: many }));
      const list = fields.find((f) => f.label === "Work in this release");
      // A truncated title reads as a real title, and the model completes it into
      // a feature that does not exist.
      for (const line of list!.value.split("\n")) {
        if (line.startsWith("- ")) expect(line).toMatch(/\)$/);
      }
    });

    it("tells the model it has not been shown everything", () => {
      const { fields, systemPrompt } = assembleReleaseContext(
        input({ groups: many }),
      );
      expect(
        fields.find((f) => f.label === "Work in this release")?.truncated,
      ).toBe(true);
      // Announced in the prompt, not only in the UI: otherwise the draft is
      // confidently about a release the model has not seen all of.
      expect(systemPrompt).toContain("you have not been shown every item");
    });
  });

  it("sends no assignees, no descriptions, and no internal notes", () => {
    const { systemPrompt } = assembleReleaseContext(input());
    // The input type has no field for any of these, so this guards the shape of
    // the module rather than a branch in it: the test fails the day someone
    // widens the input and forgets what that means.
    expect(systemPrompt).not.toMatch(/assignee|Assigned/i);
    expect(systemPrompt).not.toMatch(/planning notes/i);
  });
});
