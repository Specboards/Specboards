import { describe, expect, it } from "vitest";

import {
  assembleItemContext,
  BODY_CHAR_LIMIT,
  CHILD_LIMIT,
  type ItemContextInput,
} from "./item-context";

function input(over: Partial<ItemContextInput> = {}): ItemContextInput {
  return {
    title: "Assistant panel on the item detail",
    levelLabel: "Feature",
    statusLabel: "In progress",
    body: "A conversation surface next to the spec you are working on.",
    parentTitle: "Spec assistant",
    parentLevelLabel: "Epic",
    children: [],
    goals: [],
    tags: [],
    canEdit: true,
    ...over,
  };
}

describe("what the assistant is told about an item", () => {
  it("puts the item's own facts in the prompt", () => {
    const { systemPrompt } = assembleItemContext(input());
    expect(systemPrompt).toContain("Assistant panel on the item detail");
    expect(systemPrompt).toContain("Feature");
    expect(systemPrompt).toContain("In progress");
    expect(systemPrompt).toContain("A conversation surface next to the spec");
  });

  it("uses the workspace's own words for level and status", () => {
    // Levels and workflows are configurable. Sending the internal keys would
    // have the assistant answer in a vocabulary the customer does not use.
    const { systemPrompt } = assembleItemContext(
      input({ levelLabel: "Bet", statusLabel: "Shaping" }),
    );
    expect(systemPrompt).toContain("Bet");
    expect(systemPrompt).toContain("Shaping");
    expect(systemPrompt).not.toContain("in_progress");
  });

  it("names the parent using the parent's own level label", () => {
    const { fields } = assembleItemContext(
      input({ parentTitle: "Bring your own model", parentLevelLabel: "Epic" }),
    );
    expect(fields.find((f) => f.label === "Parent epic")?.value).toBe(
      "Bring your own model",
    );
  });

  it("tells a model that cannot propose that it cannot change anything", () => {
    // The hard constraint of this epic is that the assistant never writes. A
    // model that believes it has applied an edit will say so, and the person
    // reading that has no reason to doubt it.
    const { systemPrompt } = assembleItemContext(input({ canEdit: false }));
    expect(systemPrompt).toMatch(/no write access|cannot change anything/i);
  });

  it("tells a model that can propose that proposing is still not editing", () => {
    // The same failure with a subtler cause. Once a model has been told it may
    // propose, "I've updated the spec" becomes the natural way to describe what
    // it just did, and the person never clicks accept because they believe it
    // is done.
    const { systemPrompt } = assembleItemContext(input({ canEdit: true }));
    expect(systemPrompt).toMatch(/Proposing is not editing/);
    expect(systemPrompt).toMatch(/Never say you have made, applied or\s+saved/);
  });

  it("does not offer proposing to someone who could not accept", () => {
    // A reader with no write access being asked "shall I draft that for you?"
    // by something that cannot is worse than it never coming up.
    const { systemPrompt, canPropose } = assembleItemContext(
      input({ canEdit: false }),
    );
    expect(systemPrompt).not.toContain("BEGIN PROPOSED SPEC");
    expect(canPropose).toBe(false);
  });

  it("withdraws the offer when the description was too long to send whole", () => {
    // The expensive one. A proposal is a whole replacement body: a model shown
    // the first 8,000 characters of a spec and asked to rewrite it proposes
    // those 8,000 characters back, and accepting deletes the rest. Nothing
    // about that looks unusual to the person who asked for the edit.
    const { systemPrompt, canPropose, fields } = assembleItemContext(
      input({ canEdit: true, body: "x".repeat(BODY_CHAR_LIMIT + 1) }),
    );
    expect(fields.find((f) => f.label === "Description")?.truncated).toBe(true);
    expect(canPropose).toBe(false);
    expect(systemPrompt).not.toContain("BEGIN PROPOSED SPEC");
    // Withdrawn with a reason, so the model can say why rather than refusing
    // for no stated cause, which reads as it being broken.
    expect(systemPrompt).toMatch(/not been shown\s+all of its description/);
  });

  it("still offers proposing on a description that just fits", () => {
    // The boundary either side of it, because "truncated" is the whole
    // condition and an off-by-one here silently turns the feature off.
    const { canPropose } = assembleItemContext(
      input({ canEdit: true, body: "x".repeat(BODY_CHAR_LIMIT) }),
    );
    expect(canPropose).toBe(true);
  });
});

describe("what is deliberately left out", () => {
  it("omits a field rather than sending it empty", () => {
    const { systemPrompt, fields } = assembleItemContext(
      input({ parentTitle: null, parentLevelLabel: null, body: "" }),
    );
    // Not "Parent: none": that is noise in the prompt, and a line in the
    // disclosure claiming we sent something we did not.
    expect(fields.map((f) => f.label)).not.toContain("Parent");
    expect(fields.map((f) => f.label)).not.toContain("Description");
    expect(systemPrompt).not.toMatch(/parent/i);
  });

  it("omits a body that is only whitespace", () => {
    const { fields } = assembleItemContext(input({ body: "   \n\n  " }));
    expect(fields.map((f) => f.label)).not.toContain("Description");
  });

  it("sends no field the caller did not supply", () => {
    // The whole input surface is item facts. If a name, an email or another
    // item's content ever reaches the endpoint it has to come through here, so
    // this asserts the field list is closed rather than open.
    const { fields } = assembleItemContext(input());
    expect(fields.map((f) => f.label).sort()).toEqual([
      "Description",
      "Level",
      "Parent epic",
      "Status",
      "Title",
    ]);
  });
});

describe("the disclosure and the request cannot drift apart", () => {
  it("builds the prompt out of exactly the fields it discloses", () => {
    const { systemPrompt, fields } = assembleItemContext(
      input({
        tags: ["area:ai", "tier-2"],
        goals: ["Teams define work faster"],
        children: [{ title: "Persist the thread", statusLabel: "Backlog" }],
      }),
    );
    // Every disclosed value appears in what is sent...
    for (const f of fields) expect(systemPrompt).toContain(f.value);
    // ...and the parts of the prompt that are not the standing instructions are
    // all accounted for by a disclosed field.
    const body = systemPrompt.split("\n\n---\n\n")[1]!;
    for (const f of fields) {
      expect(body).toContain(f.label);
    }
  });
});

describe("shortening long content", () => {
  it("cuts an over-long body to the budget", () => {
    const long = "x".repeat(BODY_CHAR_LIMIT + 500);
    const { fields } = assembleItemContext(input({ body: long }));
    const description = fields.find((f) => f.label === "Description")!;
    expect(description.value).toHaveLength(BODY_CHAR_LIMIT);
    expect(description.truncated).toBe(true);
  });

  it("tells the model when it has only been shown part of something", () => {
    // Otherwise it answers confidently about a document whose end it never
    // saw, and the reader cannot tell that is what happened.
    const { systemPrompt } = assembleItemContext(
      input({ body: "y".repeat(BODY_CHAR_LIMIT + 1) }),
    );
    expect(systemPrompt).toMatch(/shortened/i);
  });

  it("leaves a body inside the budget exactly as written", () => {
    const body = "Short and complete.";
    const { fields } = assembleItemContext(input({ body }));
    const description = fields.find((f) => f.label === "Description")!;
    expect(description.value).toBe(body);
    expect(description.truncated).toBe(false);
  });

  it("caps a long child list and says it did", () => {
    const children = Array.from({ length: CHILD_LIMIT + 5 }, (_, i) => ({
      title: `Child ${i}`,
      statusLabel: "Backlog",
    }));
    const { fields } = assembleItemContext(input({ children }));
    const listed = fields.find((f) => f.label === "Child items")!;
    expect(listed.value.split("\n")).toHaveLength(CHILD_LIMIT);
    expect(listed.truncated).toBe(true);
  });

  it("does not claim to have shortened a child list that fit", () => {
    const { fields } = assembleItemContext(
      input({ children: [{ title: "Only child", statusLabel: "Done" }] }),
    );
    expect(fields.find((f) => f.label === "Child items")!.truncated).toBe(false);
  });
});

describe("a skill in force", () => {
  const skill = {
    key: "grill",
    surface: "item" as const,
    name: "Grill me",
    description: "Shown on a button; not for the model.",
    instructions: "Ask the awkward question first.",
  };

  it("adds the skill's instructions to the prompt", () => {
    const { systemPrompt } = assembleItemContext(input(), skill);
    expect(systemPrompt).toContain("Ask the awkward question first.");
  });

  it("leaves the prompt alone when no skill is running", () => {
    expect(assembleItemContext(input()).systemPrompt).toBe(
      assembleItemContext(input(), null).systemPrompt,
    );
  });

  it("puts the skill after the rules and before the item", () => {
    // Order is the safety property: a team's own wording arriving before "you
    // cannot change anything" reads as permission to do whatever it describes.
    const { systemPrompt } = assembleItemContext(input({ canEdit: false }), skill);
    const rules = systemPrompt.indexOf("You cannot change anything");
    const task = systemPrompt.indexOf("Your current task");
    const item = systemPrompt.indexOf("Assistant panel on the item detail");
    expect(rules).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(rules);
    expect(item).toBeGreaterThan(task);
  });

  it("does not let a skill turn off the no-writes rule for a reader", () => {
    // A workspace can write anything it likes into a skill. What it must not be
    // able to do is talk the assistant into claiming it saved something.
    const { systemPrompt, canPropose } = assembleItemContext(
      input({ canEdit: false }),
      { ...skill, instructions: "Apply your changes to the item directly." },
    );
    expect(systemPrompt).toContain("nothing you say is applied to the item");
    expect(canPropose).toBe(false);
  });

  it("does not send the skill's description", () => {
    const { systemPrompt } = assembleItemContext(input(), skill);
    expect(systemPrompt).not.toContain("Shown on a button");
  });
});

describe("a skill that asks for more than the reader may do", () => {
  // A skill is free text a customer wrote, and one of the ones we ship says in
  // as many words "propose it as an edit". The prompt must not carry both that
  // and "you cannot propose an edit" with nothing to break the tie.
  const drafting = {
    key: "draft",
    surface: "item" as const,
    name: "Draft a definition",
    description: "",
    instructions: "Write the description in full and propose it as an edit.",
  };

  it("adds the backstop after the skill for a reader who cannot write", () => {
    const { systemPrompt } = assembleItemContext(
      input({ canEdit: false }),
      drafting,
    );
    const asked = systemPrompt.indexOf("propose it as an edit");
    const backstop = systemPrompt.indexOf("cannot propose an");
    expect(backstop).toBeGreaterThan(asked);
  });

  it("adds it when the description was too long to send whole", () => {
    const { systemPrompt, canPropose } = assembleItemContext(
      input({ body: "x".repeat(BODY_CHAR_LIMIT + 1) }),
      drafting,
    );
    expect(canPropose).toBe(false);
    expect(systemPrompt).toContain("cannot propose an");
  });

  it("leaves the skill alone when proposing is genuinely available", () => {
    const { systemPrompt, canPropose } = assembleItemContext(input(), drafting);
    expect(canPropose).toBe(true);
    expect(systemPrompt).not.toContain("Whatever that task says");
  });
});
