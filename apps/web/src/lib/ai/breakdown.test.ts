import { describe, expect, it } from "vitest";

import {
  BREAKDOWN_CLOSE,
  BREAKDOWN_OPEN,
  MAX_PROPOSED_CHILDREN,
  breakdownInstructions,
  parseBreakdown,
} from "./breakdown";

/**
 * Reading a decomposition back out of a model's answer.
 *
 * Every case below is a way a model gets the format nearly right, because that
 * is what actually happens. A parser that only handles the documented shape
 * presents as "the suggest button does nothing", with nothing to debug and no
 * error anywhere. The stakes are higher than for a spec proposal too: a
 * mangled title becomes a card with a name somebody has to go and fix.
 */

const wrap = (body: string) => `${BREAKDOWN_OPEN}\n${body}\n${BREAKDOWN_CLOSE}`;

describe("reading a proposed breakdown", () => {
  it("finds nothing in an ordinary answer", () => {
    const { children, prose } = parseBreakdown("This looks small enough already.");
    expect(children).toEqual([]);
    expect(prose).toBe("This looks small enough already.");
  });

  it("separates the reasoning from the list", () => {
    const { prose, children } = parseBreakdown(
      `Split by surface.\n\n${wrap(
        "- Connect a provider\n  Settings screen and key storage.\n- Ask a question\n  The panel on an item.",
      )}`,
    );
    expect(prose).toBe("Split by surface.");
    expect(children).toEqual([
      { title: "Connect a provider", details: "Settings screen and key storage." },
      { title: "Ask a question", details: "The panel on an item." },
    ]);
  });

  it("takes a title with no description", () => {
    // A title alone is still a usable card, and refusing it would drop half a
    // decomposition because the model got terse near the end.
    const { children } = parseBreakdown(wrap("- Connect a provider\n- Ask a question"));
    expect(children).toEqual([
      { title: "Connect a provider", details: "" },
      { title: "Ask a question", details: "" },
    ]);
  });

  it("accepts the bullet characters models actually use", () => {
    const { children } = parseBreakdown(
      wrap("* Starred\n+ Plussed\n1. Numbered\n2) Parenthesised"),
    );
    expect(children.map((c) => c.title)).toEqual([
      "Starred",
      "Plussed",
      "Numbered",
      "Parenthesised",
    ]);
  });

  it("splits a bold title from its description on one line", () => {
    // Models do this constantly whatever the prompt says. Left alone it
    // produces a card literally titled "**Connect a provider**: settings...".
    const { children } = parseBreakdown(
      wrap("- **Connect a provider**: settings screen and key storage."),
    );
    expect(children).toEqual([
      {
        title: "Connect a provider",
        details: "settings screen and key storage.",
      },
    ]);
  });

  it("gathers a description spread over several lines", () => {
    const { children } = parseBreakdown(
      wrap("- Connect a provider\n  Settings screen.\n  And key storage."),
    );
    expect(children[0]!.details).toBe("Settings screen. And key storage.");
  });

  it("takes the rest of the message when the closing marker never came", () => {
    const { children } = parseBreakdown(
      `Here:\n${BREAKDOWN_OPEN}\n- Connect a provider\n- Ask a question`,
    );
    expect(children).toHaveLength(2);
  });

  it("ignores a code fence the model wrapped the list in", () => {
    const { children } = parseBreakdown(wrap("```\n- Connect a provider\n```"));
    expect(children).toEqual([{ title: "Connect a provider", details: "" }]);
  });

  it("drops preamble the model put inside the block", () => {
    // Text before the first bullet is not a card. Attaching it to the first one
    // would put the model's throat-clearing in a card description.
    const { children } = parseBreakdown(
      wrap("Here is the breakdown:\n- Connect a provider"),
    );
    expect(children).toEqual([{ title: "Connect a provider", details: "" }]);
  });

  it("treats an empty block as no proposal rather than one blank card", () => {
    expect(parseBreakdown(wrap("")).children).toEqual([]);
    expect(parseBreakdown(wrap("   \n\n  ")).children).toEqual([]);
  });

  it("reports an empty block as a considered answer, not a parse failure", () => {
    // The model is told to propose nothing when the breakdown already looks
    // complete, so an empty block is a real answer and its prose is the point.
    const { prose, children } = parseBreakdown(
      `This is already broken down.\n${wrap("")}`,
    );
    expect(children).toEqual([]);
    expect(prose).toBe("This is already broken down.");
  });

  it("stops before it can put a hundred tick boxes on the screen", () => {
    const many = Array.from({ length: 60 }, (_, i) => `- Item ${i}`).join("\n");
    expect(parseBreakdown(wrap(many)).children).toHaveLength(
      MAX_PROPOSED_CHILDREN,
    );
  });

  it("does not mistake a marker mentioned in a sentence for a block", () => {
    const text = `Write ${BREAKDOWN_OPEN} on its own line to propose a breakdown.`;
    expect(parseBreakdown(text).children).toEqual([]);
  });

  it("keeps a hyphen inside a title from being read as a new item", () => {
    const { children } = parseBreakdown(wrap("- Rate-limit the public API"));
    expect(children).toEqual([
      { title: "Rate-limit the public API", details: "" },
    ]);
  });
});

describe("what the model is told about breaking an item down", () => {
  it("quotes the markers the parser looks for", () => {
    // The prompt and the parser agreeing is the whole contract.
    const rules = breakdownInstructions("Feature", []);
    expect(rules).toContain(BREAKDOWN_OPEN);
    expect(rules).toContain(BREAKDOWN_CLOSE);
  });

  it("uses the workspace's own word for the level below", () => {
    // Levels are configurable. Asking for "features" in a workspace that calls
    // them Bets gets a proposal at a level that does not exist.
    expect(breakdownInstructions("Bet", [])).toContain("Bet items");
    expect(breakdownInstructions("Bet", [])).not.toContain("feature items");
  });

  it("asks for the gap when children already exist", () => {
    const rules = breakdownInstructions("Feature", ["Connect a provider"]);
    expect(rules).toMatch(/only what is missing/);
    expect(rules).toMatch(/propose nothing/);
  });

  it("says nothing about existing children when there are none", () => {
    // A first breakdown told to "propose only what is missing beside them"
    // reads as though something is already there, and models hedge.
    expect(breakdownInstructions("Feature", [])).not.toMatch(/already has/);
  });

  it("forbids claiming anything was created", () => {
    expect(breakdownInstructions("Feature", [])).toMatch(/not say you have created/);
  });
});
