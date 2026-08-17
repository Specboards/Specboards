import { describe, expect, it } from "vitest";

import {
  BUILT_IN_SKILLS,
  MAX_SKILLS,
  MAX_SKILL_INSTRUCTION_CHARS,
  mergeSkills,
  parseSkills,
  SkillInputError,
  skillKeyFrom,
  skillRowsToStore,
  skillTask,
  type Skill,
  type SkillRow,
} from "./skills";

function row(over: Partial<SkillRow> = {}): SkillRow {
  return {
    key: "ours",
    name: "Our way",
    description: "",
    instructions: "Do it our way.",
    enabled: true,
    position: 0,
    ...over,
  };
}

function skill(over: Partial<Skill> = {}): Skill {
  const { position: _position, ...rest } = row();
  return { ...rest, builtIn: false, customised: false, ...over };
}

describe("the skills a workspace has", () => {
  it("gives a workspace with no rows the built-ins, in code order", () => {
    const skills = mergeSkills([]);
    expect(skills.map((s) => s.key)).toEqual(BUILT_IN_SKILLS.map((b) => b.key));
    expect(skills.every((s) => s.builtIn && s.enabled && !s.customised)).toBe(true);
  });

  it("puts a team's own skills after the built-ins", () => {
    const skills = mergeSkills([row({ key: "ours" })]);
    expect(skills.at(-1)).toMatchObject({ key: "ours", builtIn: false });
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

  it("keeps a built-in in its own place when it is overridden", () => {
    // Otherwise customising the first skill moves it to the end of the row, and
    // the button someone reaches for by position is now a different one.
    const before = mergeSkills([]).map((s) => s.key);
    const after = mergeSkills([row({ key: "grill", position: 9 })]).map((s) => s.key);
    expect(after).toEqual(before);
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
    expect(skills.slice(BUILT_IN_SKILLS.length).map((s) => s.key)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("deciding what is worth storing", () => {
  it("stores nothing for a workspace that changed nothing", () => {
    // The point of the whole design: opening the settings page and pressing Save
    // must not pin a workspace to today's wording of prompts we still intend to
    // improve.
    expect(skillRowsToStore(mergeSkills([]))).toEqual([]);
  });

  it("stores a built-in once its wording is changed", () => {
    const skills = mergeSkills([]).map((s) =>
      s.key === "grill" ? { ...s, instructions: "Ask harder." } : s,
    );
    const stored = skillRowsToStore(skills);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key: "grill", instructions: "Ask harder." });
  });

  it("stores a built-in that was switched off, even unedited", () => {
    const skills = mergeSkills([]).map((s) =>
      s.key === "draft" ? { ...s, enabled: false } : s,
    );
    expect(skillRowsToStore(skills).map((s) => s.key)).toEqual(["draft"]);
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
