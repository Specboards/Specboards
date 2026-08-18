import { describe, expect, it } from "vitest";

import {
  assembleReleaseContext,
  descriptionShare,
  ITEM_LIST_CHAR_LIMIT,
  MAX_ITEM_DESCRIPTION_CHARS,
  NOTES_CHAR_LIMIT,
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
        items: [
          {
            title: "Single sign-on",
            statusLabel: "Done",
            description: "Lets an admin connect an identity provider.",
          },
        ],
      },
      {
        levelLabel: "Feature",
        items: [
          {
            title: "SAML metadata upload",
            statusLabel: "In review",
            description: "",
          },
        ],
      },
    ] as ReleaseContextGroup[],
    notesBody: "",
    canEdit: true,
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

  it("names the audience", () => {
    const { systemPrompt } = assembleReleaseContext(input());
    expect(systemPrompt).toContain("customer-facing release notes");
  });

  describe("what the model is told it may do", () => {
    it("invites a proposal from someone who can write the release", () => {
      const assembled = assembleReleaseContext(input({ canEdit: true }));
      expect(assembled.canPropose).toBe(true);
      expect(assembled.systemPrompt).toContain("BEGIN PROPOSED SPEC");
      expect(assembled.systemPrompt).toContain("this release's notes");
      // The rule that makes the whole feature trustworthy.
      expect(assembled.systemPrompt).toContain("Proposing is not editing.");
    });

    it("tells a reader plainly that nothing they see is saved", () => {
      const assembled = assembleReleaseContext(input({ canEdit: false }));
      expect(assembled.canPropose).toBe(false);
      expect(assembled.systemPrompt).toContain("You cannot change anything.");
      // Not merely withheld from the prompt: a model with no rule about writing
      // answers "I have published those for you" and the person believes it.
      expect(assembled.systemPrompt).not.toContain("BEGIN PROPOSED SPEC");
    });

    it("withdraws the offer when the notes were too long to send whole", () => {
      const assembled = assembleReleaseContext(
        input({ canEdit: true, notesBody: "x".repeat(NOTES_CHAR_LIMIT + 1) }),
      );
      // Withdrawn rather than qualified: a proposal is a whole replacement, so
      // one drafted from a shortened document deletes everything past the cut.
      expect(assembled.canPropose).toBe(false);
      expect(assembled.systemPrompt).not.toContain("BEGIN PROPOSED SPEC");
      expect(assembled.systemPrompt).toContain("too long to send");
      expect(
        assembled.fields.find((f) => f.label === "Current release notes")?.truncated,
      ).toBe(true);
    });
  });

  describe("the notes being edited", () => {
    it("sends them last, so the document sits nearest the answer", () => {
      const { fields } = assembleReleaseContext(
        input({ notesBody: "## What is new\nSSO." }),
      );
      expect(fields.at(-1)?.label).toBe("Current release notes");
      expect(fields.at(-1)?.value).toBe("## What is new\nSSO.");
    });

    it("omits the field entirely when nobody has written any", () => {
      const { fields } = assembleReleaseContext(input({ notesBody: "" }));
      expect(fields.some((f) => f.label === "Current release notes")).toBe(false);
    });
  });

  describe("a running skill", () => {
    const skill = {
      key: "release-notes",
      surface: "release" as const,
      name: "Draft the notes",
      description: "",
      instructions: "Write them in the house style.",
    };

    it("puts the task after the rules and before the release", () => {
      const { systemPrompt } = assembleReleaseContext(input(), skill);
      const rules = systemPrompt.indexOf("Proposing is not editing.");
      const task = systemPrompt.indexOf("Write them in the house style.");
      const release = systemPrompt.indexOf("Release: v1.4.0");
      // Who you are, then what you may do, then the job, then the thing itself.
      expect(rules).toBeLessThan(task);
      expect(task).toBeLessThan(release);
    });

    it("overrides a skill that asks for something this conversation cannot do", () => {
      const { systemPrompt } = assembleReleaseContext(
        input({ canEdit: false }),
        skill,
      );
      // A skill is free text a customer wrote, and ours says "propose them".
      // Ours has to be the instruction nearest the end, which is the one a small
      // model follows.
      const task = systemPrompt.indexOf("Write them in the house style.");
      const override = systemPrompt.indexOf("cannot propose");
      expect(override).toBeGreaterThan(task);
    });
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
          description: "",
        })),
      },
      {
        levelLabel: "Work Item",
        items: Array.from({ length: 400 }, (_, i) => ({
          title: `A work item with a reasonably long title, number ${i}`,
          statusLabel: "Done",
          description: "",
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

  it("sends no assignees and no internal planning notes", () => {
    const { systemPrompt } = assembleReleaseContext(input());
    // The input type has no field for either, so this guards the shape of the
    // module rather than a branch in it: the test fails the day someone widens
    // the input and forgets what that means. Item descriptions ARE sent, on
    // purpose, and are covered below.
    expect(systemPrompt).not.toMatch(/assignee|Assigned/i);
    expect(systemPrompt).not.toMatch(/planning notes/i);
  });

  describe("item descriptions", () => {
    /** A release of `count` items, each with a description of `chars`. */
    function sized(count: number, chars: number): ReleaseContextGroup[] {
      return [
        {
          levelLabel: "Feature",
          items: Array.from({ length: count }, (_, i) => ({
            title: `Item ${i}`,
            statusLabel: "Done",
            description: `d${i} `.padEnd(chars, "x"),
          })),
        },
      ];
    }

    it("sends them, which is the whole point of asking about a release", () => {
      const { systemPrompt, descriptionsIncluded } = assembleReleaseContext(input());
      expect(systemPrompt).toContain("Lets an admin connect an identity provider.");
      expect(descriptionsIncluded).toBe(1);
    });

    it("counts an item with no description as undescribed rather than empty", () => {
      // The SAML item in the fixture has none. Sending a blank line under it
      // would tell the model there is nothing to say, which is not the same as
      // nobody having written it up yet.
      const { descriptionsIncluded } = assembleReleaseContext(input());
      expect(descriptionsIncluded).toBe(1);
    });

    it("shares one budget evenly rather than first come first served", () => {
      // Uneven shares read as a bug: whichever epic sorts first arrives whole
      // and the rest are stubs, so the ordering looks like a judgement.
      const assembled = assembleReleaseContext(input({ groups: sized(20, 4_000) }));
      const list = assembled.fields.find((f) => f.label === "Work in this release")!;
      const bodies = list.value
        .split("\n")
        .filter((l) => l.startsWith("  "))
        .map((l) => l.length);
      expect(new Set(bodies).size).toBe(1);
      expect(assembled.descriptionsShortened).toBe(20);
    });

    it("never spends more than the per-item cap on a small release", () => {
      // Three items must not get eight thousand characters each just because
      // the budget divides that way: one rambling spec would crowd out the rest.
      const assembled = assembleReleaseContext(input({ groups: sized(2, 20_000) }));
      const list = assembled.fields.find((f) => f.label === "Work in this release")!;
      for (const line of list.value.split("\n").filter((l) => l.startsWith("  "))) {
        expect(line.length).toBeLessThanOrEqual(MAX_ITEM_DESCRIPTION_CHARS + 4);
      }
    });

    it("drops every description rather than sending useless fragments", () => {
      // Hundred-character stubs of three hundred specs are worse than none:
      // each stops mid-sentence and the model writes confidently from them.
      const assembled = assembleReleaseContext(input({ groups: sized(400, 3_000) }));
      expect(assembled.descriptionsIncluded).toBe(0);
      // The titles survive, because a title names work that shipped and losing
      // one loses a change from the notes entirely.
      expect(assembled.itemsIncluded).toBeGreaterThan(300);
    });

    it("keeps the whole list inside the budget", () => {
      const { fields } = assembleReleaseContext(input({ groups: sized(30, 5_000) }));
      const list = fields.find((f) => f.label === "Work in this release");
      expect(list!.value.length).toBeLessThanOrEqual(ITEM_LIST_CHAR_LIMIT);
    });

    it("marks a shortened description so it is not read as complete", () => {
      const { fields } = assembleReleaseContext(input({ groups: sized(20, 4_000) }));
      const list = fields.find((f) => f.label === "Work in this release")!;
      expect(list.value).toContain("…");
    });
  });

  describe("sharing the description budget", () => {
    it("gives everything to one item, up to the cap", () => {
      expect(descriptionShare(1, 100_000)).toBe(MAX_ITEM_DESCRIPTION_CHARS);
    });

    it("divides evenly between many, less each one's overhead", () => {
      // 1,000 each, minus the four characters an indented, ellipsised line
      // costs beyond its own text.
      expect(descriptionShare(10, 10_000)).toBe(996);
    });

    it("gives up rather than slicing too thin", () => {
      expect(descriptionShare(1_000, 10_000)).toBe(0);
    });

    it("is zero when nothing has a description", () => {
      expect(descriptionShare(0, 10_000)).toBe(0);
    });

    it("is zero when the titles already used the budget", () => {
      // A negative remainder is a real case: titles are paid for first.
      expect(descriptionShare(5, -100)).toBe(0);
    });
  });
});
