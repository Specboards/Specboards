import { describe, expect, it } from "vitest";

import { assembleItemContext, type ItemContextInput } from "./item-context";
import { BUILT_IN_SKILLS } from "./skills";

/**
 * What the architecture review sends, and what it tells the person it sent.
 *
 * `item-context.ts` earns its purity from one property: the prompt is derived
 * from the same field list the disclosure renders, so nothing can reach a
 * customer's model provider without appearing in the list they were shown.
 * Architecture pages are the first thing ever sent that is not the item itself,
 * which makes this the moment that property is most likely to be quietly lost.
 *
 * So these tests are mostly about the disclosure rather than about the prompt.
 */

function input(over: Partial<ItemContextInput> = {}): ItemContextInput {
  return {
    canEdit: true,
    title: "Retry failed payments",
    levelLabel: "Feature",
    statusLabel: "Ready",
    body: "Payments that fail once should be retried.",
    parentTitle: null,
    parentLevelLabel: null,
    children: [],
    goals: [],
    tags: [],
    ...over,
  };
}

const architecture = {
  outline: ["Architecture", "Payments", "Events/Bus"],
  outlineTruncated: false,
  pages: [
    { path: "Architecture", body: "Services talk over the event bus." },
    { path: "Payments", body: "Payments are never retried automatically." },
  ],
};

describe("architecture in the prompt", () => {
  it("lists every page it sent in the disclosure, by name", () => {
    // The property the whole design rests on. A team whose architecture docs
    // are confidential has to be able to see which pages are about to leave,
    // and "architecture (2 pages)" would not be that.
    const { fields } = assembleItemContext(input({ architecture }));
    const labels = fields.map((f) => f.label);
    expect(labels).toContain("Architecture page: Architecture");
    expect(labels).toContain("Architecture page: Payments");
  });

  it("puts the page text in the prompt, so the disclosure is not a claim about nothing", () => {
    const { systemPrompt } = assembleItemContext(input({ architecture }));
    expect(systemPrompt).toContain("Payments are never retried automatically.");
  });

  it("sends nothing at all when no skill asked for it", () => {
    // An ordinary turn, and every skill but one, still runs on the item alone.
    // Sending the architecture area because it exists would widen what leaves
    // the building for people who never asked.
    const { fields, systemPrompt } = assembleItemContext(input());
    expect(fields.some((f) => f.label.startsWith("Architecture"))).toBe(false);
    expect(systemPrompt).not.toMatch(/Architecture/);
  });

  it("marks which outlined pages it actually read", () => {
    // A model handed a list of pages and the text of some of them cannot tell
    // which unless it is told, and a model that cannot tell will cite a page it
    // never read. That is precisely the failure the skill's last rule is about.
    const { fields } = assembleItemContext(input({ architecture }));
    const outline = fields.find(
      (f) => f.label === "Architecture pages in this product",
    );
    expect(outline?.value).toContain("Payments (text below)");
    expect(outline?.value).toContain("Events/Bus");
    expect(outline?.value).not.toContain("Events/Bus (text below)");
  });

  it("says when the area held more pages than the outline could list", () => {
    const { fields } = assembleItemContext(
      input({ architecture: { ...architecture, outlineTruncated: true } }),
    );
    const outline = fields.find(
      (f) => f.label === "Architecture pages in this product",
    );
    expect(outline?.truncated).toBe(true);
  });

  it("keeps the item last, after the reference material", () => {
    // The architecture is what the item is being read against; the item is the
    // subject. The subject reads best nearest the question.
    const { fields } = assembleItemContext(input({ architecture }));
    const labels = fields.map((f) => f.label);
    expect(labels.indexOf("Description")).toBeGreaterThan(
      labels.lastIndexOf("Architecture page: Payments"),
    );
  });
});

describe("the architecture skill itself", () => {
  const skill = BUILT_IN_SKILLS.find((s) => s.key === "architecture-impact")!;

  it("is the only built-in that reads anything beyond its item", () => {
    // Reading the architecture area is a widening, and a widening that spread
    // quietly to other skills would be the kind nobody decided on.
    const readers = BUILT_IN_SKILLS.filter((s) => s.reads);
    expect(readers.map((s) => s.key)).toEqual(["architecture-impact"]);
    expect(skill.reads).toEqual(["architecture"]);
  });

  it("runs on items, where specs are", () => {
    expect(skill.surface).toBe("item");
  });

  it("tells the model to cite the page or drop the claim", () => {
    // The rule that decides whether anybody runs this twice. Last in the
    // instructions on purpose, which is where a small model is likeliest to
    // keep it.
    expect(skill.instructions).toMatch(/Name the page, or do not make the claim/);
  });

  it("tells the model that a page it was not shown still exists", () => {
    expect(skill.instructions).toMatch(/say you could not read it/);
  });
});
