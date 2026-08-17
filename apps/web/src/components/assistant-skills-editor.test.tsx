import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AssistantSkillsEditor,
  SORT_CONTROL_THRESHOLD,
} from "./assistant-skills-editor";
import { mergeSkills, type Skill } from "@/lib/ai/skills";

/**
 * What the skills editor shows before anyone touches it.
 *
 * Rendered to static markup, like the other component tests here: the behaviour
 * behind the buttons lives in `lib/ai/skills.ts` and is tested directly, and
 * this pins the things that are only true in the markup.
 */

function render(skills: Skill[], canEdit = true) {
  return renderToStaticMarkup(
    <AssistantSkillsEditor initial={skills} canEdit={canEdit} />,
  );
}

function own(key: string, name: string): Skill {
  return {
    key,
    name,
    description: "",
    instructions: "Do a thing.",
    builtIn: false,
    customised: false,
    enabled: true,
  };
}

describe("the skills editor", () => {
  it("offers a move control per skill, named after the skill", () => {
    // Named rather than "Move up", because a screen reader user arrowing
    // through six identical "Move up" buttons cannot tell which row they are on.
    const markup = render(mergeSkills([]));
    expect(markup).toContain("Move Grill me up");
    expect(markup).toContain("Move Grill me down");
  });

  it("disables the moves that would go off either end", () => {
    const markup = render(mergeSkills([]));
    const first = markup.indexOf("Move Grill me up");
    const last = markup.indexOf("Move Draft a definition down");
    // The disabled attribute sits just before the label in the same tag.
    expect(markup.slice(0, first)).toMatch(/disabled=""[^<]*$/);
    expect(markup.slice(0, last)).toMatch(/disabled=""[^<]*$/);
  });

  it("does not offer the moves to somebody who cannot edit", () => {
    expect(render(mergeSkills([]), false)).not.toContain("Move Grill me up");
  });

  it("keeps the A to Z control away until there is something to sort", () => {
    // Sorting three buttons is not organising anything, and a control nobody
    // needs still has to be read and dismissed by everyone who opens the page.
    expect(render(mergeSkills([]))).not.toContain("Sort A to Z");
  });

  it("offers A to Z once a workspace has enough skills", () => {
    const extra = Array.from(
      { length: SORT_CONTROL_THRESHOLD },
      (_, i) => own(`ours-${i}`, `Ours ${i}`),
    );
    expect(render([...mergeSkills([]), ...extra])).toContain("Sort A to Z");
  });

  it("does not offer Remove on a built-in", () => {
    // It would come straight back on the next load, since it lives in the code.
    // Switching it off is the thing that actually means "not for us".
    const markup = render(mergeSkills([]));
    expect(markup).not.toContain("Remove");
    expect(markup).toContain("Switch off");
  });
});
