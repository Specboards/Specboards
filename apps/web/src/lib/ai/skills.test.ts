import { describe, expect, it } from "vitest";

import {
  BUILT_IN_SKILLS,
  MAX_SKILLS,
  MAX_SKILL_INSTRUCTION_CHARS,
  mergeSkills,
  moveSkill,
  parseSkills,
  SkillInputError,
  skillKeyFrom,
  skillRowsToStore,
  skillsSortedByName,
  skillTask,
  type Skill,
  type SkillRow,
} from "./skills";

function row(over: Partial<SkillRow> = {}): SkillRow {
  return {
    key: "ours",
    surface: "item" as const,
    name: "Our way",
    description: "",
    instructions: "Do it our way.",
    enabled: true,
    position: 0,
    ...over,
  };
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    key: "ours",
    surface: "item" as const,
    name: "Our way",
    description: "",
    instructions: "Do it our way.",
    builtIn: false,
    customised: false,
    enabled: true,
    ...over,
  };
}

/** A row that stores only where a built-in sits, leaving its wording to us. */
function positionOnly(key: string, position: number): SkillRow {
  return {
    key,
    name: null,
    description: null,
    instructions: null,
    surface: "item",
    enabled: true,
    position,
  };
}

describe("the skills a workspace has", () => {
  it("gives a workspace with no rows the built-ins, in code order", () => {
    const skills = mergeSkills([]);
    expect(skills.map((s) => s.key)).toEqual(BUILT_IN_SKILLS.map((b) => b.key));
    expect(skills.every((s) => s.builtIn && s.enabled && !s.customised)).toBe(true);
  });

  it("gives a stored skill its place ahead of built-ins that have none", () => {
    // A stored position is something a person arranged; a missing one is a
    // built-in we shipped after they last arranged anything. Migration 0071
    // backfills the rows that make this total, so in practice the only skills
    // without a position are ones added in a release since.
    const skills = mergeSkills([row({ key: "ours" })]);
    expect(skills[0]).toMatchObject({ key: "ours", builtIn: false });
    expect(skills).toHaveLength(BUILT_IN_SKILLS.length + 1);
  });

  it("lets a row override the built-in with the same key", () => {
    const skills = mergeSkills([
      row({ key: "grill", name: "Interrogate me", instructions: "Ours." }),
    ]);
    const grill = skills.find((s) => s.key === "grill");
    expect(grill).toMatchObject({
      name: "Interrogate me",
      instructions: "Ours.",
      builtIn: true,
      customised: true,
    });
    // An override replaces rather than adds: two buttons called almost the same
    // thing, with no way to tell which a past conversation used, is the failure.
    expect(skills.filter((s) => s.key === "grill")).toHaveLength(1);
  });

  it("carries a switched-off built-in through as disabled", () => {
    const skills = mergeSkills([row({ key: "gaps", enabled: false })]);
    expect(skills.find((s) => s.key === "gaps")?.enabled).toBe(false);
  });

  it("orders a team's own skills by their stored position", () => {
    const skills = mergeSkills([
      row({ key: "b", position: 2 }),
      row({ key: "a", position: 1 }),
    ]);
    expect(skills.slice(0, 2).map((s) => s.key)).toEqual(["a", "b"]);
  });
});

describe("the order a workspace arranged", () => {
  const keys = BUILT_IN_SKILLS.map((b) => b.key);

  it("puts the built-ins wherever the stored positions say", () => {
    const reversed = [...keys].reverse();
    const skills = mergeSkills(reversed.map((k, i) => positionOnly(k, i)));
    expect(skills.map((s) => s.key)).toEqual(reversed);
  });

  it("keeps a reordered built-in's wording coming from the code", () => {
    // The whole reason the columns are nullable. If reordering stored the text,
    // every later improvement to these prompts would stop reaching a workspace
    // the day somebody dragged a button, and nobody would connect the two.
    const skills = mergeSkills([positionOnly("draft", 0), positionOnly("grill", 1)]);
    const grill = skills.find((s) => s.key === "grill")!;
    expect(grill.instructions).toBe(BUILT_IN_SKILLS.find((b) => b.key === "grill")!.instructions);
    expect(grill.customised).toBe(false);
  });

  it("resolves each field on its own", () => {
    // A team that renamed a skill but left its instructions alone keeps
    // tracking those instructions.
    const skills = mergeSkills([
      { ...positionOnly("grill", 0), name: "Interrogate me" },
    ]);
    const grill = skills.find((s) => s.key === "grill")!;
    expect(grill.name).toBe("Interrogate me");
    expect(grill.instructions).toBe(
      BUILT_IN_SKILLS.find((b) => b.key === "grill")!.instructions,
    );
    expect(grill.customised).toBe(true);
  });

  it("interleaves a team's own skills with the built-ins", () => {
    // Ordering is over one list, not two: a team that wants its own skill first
    // must be able to put it first.
    const skills = mergeSkills([
      row({ key: "ours", position: 0 }),
      positionOnly("grill", 1),
      positionOnly("gaps", 2),
      positionOnly("draft", 3),
    ]);
    expect(skills.map((s) => s.key)).toEqual([
      "ours",
      "grill",
      "gaps",
      "draft",
      // Unrowed built-ins keep code order on the end; see the test below.
      "release-notes",
      "tighten",
    ]);
  });

  it("puts a newly shipped built-in last rather than into the middle", () => {
    // A workspace that arranged its buttons a year ago should get a new one
    // appearing at the end, not silently shifting the ones people reach for by
    // position.
    const arranged = mergeSkills([positionOnly("draft", 0), positionOnly("grill", 1)]);
    expect(arranged.map((s) => s.key)).toEqual([
      "draft",
      "grill",
      "gaps",
      "release-notes",
      "tighten",
    ]);
  });

  it("moves a skill up and down without disturbing the rest", () => {
    const list = [skill({ key: "a" }), skill({ key: "b" }), skill({ key: "c" })];
    expect(moveSkill(list, 2, -1).map((s) => s.key)).toEqual(["a", "c", "b"]);
    expect(moveSkill(list, 0, 1).map((s) => s.key)).toEqual(["b", "a", "c"]);
  });

  it("composes when applied twice, which is what a burst of clicks is", () => {
    // Moving something three places is three clicks with no render between
    // them, so each move has to start from the result of the last one. The
    // editor holds that result in a ref for exactly this reason; getting it
    // wrong collapsed two clicks into one move.
    const list = ["a", "b", "c", "d"].map((key) => skill({ key }));
    const once = moveSkill(list, 3, -1);
    const twice = moveSkill(once, 2, -1);
    expect(twice.map((s) => s.key)).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the list alone at either end", () => {
    const list = [skill({ key: "a" }), skill({ key: "b" })];
    expect(moveSkill(list, 0, -1).map((s) => s.key)).toEqual(["a", "b"]);
    expect(moveSkill(list, 1, 1).map((s) => s.key)).toEqual(["a", "b"]);
  });

  it("sorts by name regardless of case", () => {
    const list = [
      skill({ key: "c", name: "apple" }),
      skill({ key: "a", name: "Banana" }),
      skill({ key: "b", name: "Cherry" }),
    ];
    expect(skillsSortedByName(list).map((s) => s.name)).toEqual([
      "apple",
      "Banana",
      "Cherry",
    ]);
  });
});

describe("deciding what is worth storing", () => {
  it("stores no text for a workspace that changed nothing", () => {
    // The point of the whole design. A row is written for every skill, because
    // position and on/off need one, but the wording stays null so it keeps
    // resolving from the code and keeps tracking prompts we still intend to
    // improve.
    const stored = skillRowsToStore(mergeSkills([]));
    expect(stored).toHaveLength(BUILT_IN_SKILLS.length);
    expect(
      stored.every(
        (r) => r.name === null && r.description === null && r.instructions === null,
      ),
    ).toBe(true);
  });

  it("stores a built-in's wording once it is changed", () => {
    const skills = mergeSkills([]).map((s) =>
      s.key === "grill" ? { ...s, instructions: "Ask harder." } : s,
    );
    const stored = skillRowsToStore(skills);
    const grill = stored.find((r) => r.key === "grill")!;
    expect(grill.instructions).toBe("Ask harder.");
    // Only the field that changed. The name and description go on tracking us.
    expect(grill.name).toBeNull();
    expect(grill.description).toBeNull();
  });

  it("stores a cleared description as empty rather than as inherit", () => {
    // Otherwise clearing our one-liner resolves back to it on the next load and
    // looks like the edit did not save.
    const skills = mergeSkills([]).map((s) =>
      s.key === "grill" ? { ...s, description: "" } : s,
    );
    expect(skillRowsToStore(skills).find((r) => r.key === "grill")!.description).toBe(
      "",
    );
  });

  it("records a built-in that was switched off, without storing its text", () => {
    const skills = mergeSkills([]).map((s) =>
      s.key === "draft" ? { ...s, enabled: false } : s,
    );
    const draft = skillRowsToStore(skills).find((r) => r.key === "draft")!;
    expect(draft.enabled).toBe(false);
    expect(draft.instructions).toBeNull();
  });

  it("survives a round trip through storage with the order intact", () => {
    const reordered = moveSkill(mergeSkills([]), 2, -2);
    const back = mergeSkills(skillRowsToStore(reordered));
    expect(back.map((s) => s.key)).toEqual(reordered.map((s) => s.key));
    expect(back.map((s) => s.instructions)).toEqual(
      reordered.map((s) => s.instructions),
    );
  });

  it("numbers positions from the order it is given", () => {
    // A merged skill carries no position of its own: the row is the order. So
    // the stored positions have to come from where things ended up on screen,
    // or an added skill goes back to a different place on the next load.
    const stored = skillRowsToStore([skill({ key: "a" }), skill({ key: "b" })]);
    expect(stored.map((s) => [s.key, s.position])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("round-trips: storing then merging reproduces what was on screen", () => {
    const edited = mergeSkills([]).map((s) =>
      s.key === "gaps" ? { ...s, name: "What is missing" } : s,
    );
    const withOwn = [...edited, skill({ key: "ours" })];
    const back = mergeSkills(skillRowsToStore(withOwn));
    expect(back.map((s) => [s.key, s.name])).toEqual(
      withOwn.map((s) => [s.key, s.name]),
    );
  });
});

describe("keys", () => {
  it("derives one from the name", () => {
    expect(skillKeyFrom("Grill me harder", [])).toBe("grill-me-harder");
  });

  it("avoids one already in use", () => {
    expect(skillKeyFrom("Grill me", ["grill-me"])).toBe("grill-me-2");
    expect(skillKeyFrom("Grill me", ["grill-me", "grill-me-2"])).toBe("grill-me-3");
  });

  it("still produces something for a name with nothing to slug", () => {
    expect(skillKeyFrom("???", [])).toBe("skill");
  });
});

describe("validating a submitted set", () => {
  it("refuses a skill with no instructions", () => {
    // It would appear as a button that does nothing, which is worse than the
    // person being told they have not finished writing it.
    expect(() => parseSkills([{ name: "Empty", instructions: "  " }])).toThrow(
      SkillInputError,
    );
  });

  it("refuses a skill with no name", () => {
    expect(() => parseSkills([{ instructions: "Do a thing." }])).toThrow(
      SkillInputError,
    );
  });

  it("refuses instructions longer than the budget", () => {
    expect(() =>
      parseSkills([
        { name: "Long", instructions: "x".repeat(MAX_SKILL_INSTRUCTION_CHARS + 1) },
      ]),
    ).toThrow(SkillInputError);
  });

  it("refuses two skills claiming one key", () => {
    expect(() =>
      parseSkills([
        { key: "grill", name: "A", instructions: "a" },
        { key: "grill", name: "B", instructions: "b" },
      ]),
    ).toThrow(SkillInputError);
  });

  it("refuses more skills than a row of buttons can hold", () => {
    const many = Array.from({ length: MAX_SKILLS + 1 }, (_, i) => ({
      name: `Skill ${i}`,
      instructions: "Do a thing.",
    }));
    expect(() => parseSkills(many)).toThrow(SkillInputError);
  });

  it("honours a well-formed key, which is what makes an override an override", () => {
    expect(parseSkills([{ key: "grill", name: "Ours", instructions: "x" }])[0]?.key)
      .toBe("grill");
  });

  it("replaces a malformed key rather than storing it", () => {
    const parsed = parseSkills([
      { key: "NOT A KEY", name: "Ours", instructions: "x" },
    ]);
    expect(parsed[0]?.key).toBe("ours");
  });

  it("trims, so a name of spaces is refused rather than stored", () => {
    const parsed = parseSkills([{ name: "  Ours  ", instructions: "  x  " }]);
    expect(parsed[0]).toMatchObject({ name: "Ours", instructions: "x" });
  });
});

describe("what a running skill tells the model", () => {
  it("names the task and then gives the instructions", () => {
    const task = skillTask({
      key: "k",
      surface: "item" as const,
      name: "Grill me",
      description: "ignored",
      instructions: "Ask hard questions.",
    });
    expect(task).toContain("Your current task: Grill me");
    expect(task).toContain("Ask hard questions.");
  });

  it("does not send the description", () => {
    // It exists to help a person choose a button. A model given it as well tends
    // to answer the description instead of doing the job.
    expect(
      skillTask({
        key: "k",
        surface: "item" as const,
        name: "n",
        description: "A one-line summary for humans",
        instructions: "i",
      }),
    ).not.toContain("A one-line summary for humans");
  });

  it("tells the built-in interrogation not to draft while it is still asking", () => {
    // The behaviour the whole feature is for: a model that answers "here is a
    // better spec" has skipped the part that was valuable.
    const grill = BUILT_IN_SKILLS.find((s) => s.key === "grill");
    expect(grill?.instructions).toMatch(/Do not propose a rewritten description/);
  });
});
