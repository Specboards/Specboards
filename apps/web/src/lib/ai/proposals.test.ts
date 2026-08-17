import { describe, expect, it } from "vitest";

import {
  PROPOSAL_CLOSE,
  PROPOSAL_INSTRUCTIONS,
  PROPOSAL_OPEN,
  parseAnswer,
  proposalStarted,
} from "./proposals";

/**
 * Reading a proposal back out of a model's answer.
 *
 * The tests that matter here are the sloppy ones. A frontier model formats the
 * block correctly every time and needs no coverage; the customer this epic
 * exists for is running a 7B model on their own hardware, and every case below
 * is a way that model gets it nearly right. Each of those, unhandled, presents
 * as "the assistant just does not propose anything" with nothing to debug.
 */

const wrap = (body: string) => `${PROPOSAL_OPEN}\n${body}\n${PROPOSAL_CLOSE}`;

describe("reading a proposal out of an answer", () => {
  it("finds nothing in an ordinary answer", () => {
    const { prose, proposal } = parseAnswer("This spec never says what happens on failure.");
    expect(proposal).toBeNull();
    expect(prose).toBe("This spec never says what happens on failure.");
  });

  it("separates what to show from what is proposed", () => {
    const { prose, proposal } = parseAnswer(
      `I added a failure section.\n\n${wrap("# Refunds\n\n## Failure\n\nRetry once.")}`,
    );
    expect(prose).toBe("I added a failure section.");
    expect(proposal).toBe("# Refunds\n\n## Failure\n\nRetry once.");
  });

  it("keeps an answer that is nothing but a proposal", () => {
    // Terse models skip the preamble. That is not a malformed answer.
    const { prose, proposal } = parseAnswer(wrap("# Refunds"));
    expect(prose).toBe("");
    expect(proposal).toBe("# Refunds");
  });

  it("takes the rest of the message when the closing marker never came", () => {
    // A model that hit its token limit mid-block has still said what it wants.
    // The truncation is visible in the diff, which is where a person can judge
    // it; dropping the proposal entirely just looks like nothing happened.
    const { proposal } = parseAnswer(`Here:\n${PROPOSAL_OPEN}\n# Refunds\n\nPartial`);
    expect(proposal).toBe("# Refunds\n\nPartial");
  });

  it("unwraps a code fence the model put round the block", () => {
    const { proposal } = parseAnswer(wrap("```markdown\n# Refunds\n```"));
    expect(proposal).toBe("# Refunds");
  });

  it("leaves a code fence that is part of the content alone", () => {
    // A spec that contains a code example must survive intact: stripping the
    // first and last fence of a body that opens and closes with unrelated
    // examples would eat two real lines.
    const body = "# API\n\n```ts\nconst a = 1;\n```\n\nDone.";
    expect(parseAnswer(wrap(body)).proposal).toBe(body);
  });

  it("treats an empty block as no proposal", () => {
    // The dangerous one. A model that emitted the markers around nothing did
    // not mean "delete this item's whole description", and accepting it would
    // be a one-click way to empty a spec.
    expect(parseAnswer(`Sure.\n${wrap("")}`).proposal).toBeNull();
    expect(parseAnswer(`Sure.\n${wrap("   \n\n  ")}`).proposal).toBeNull();
  });

  it("keeps the first of several blocks and shows none of them as text", () => {
    const { prose, proposal } = parseAnswer(
      `${wrap("first")}\nOr maybe:\n${wrap("second")}`,
    );
    expect(proposal).toBe("first");
    expect(prose).toBe("Or maybe:");
    expect(prose).not.toContain(PROPOSAL_OPEN);
  });

  it("does not mistake a marker mentioned inside a sentence for a block", () => {
    const text = `Write ${PROPOSAL_OPEN} on its own line to propose an edit.`;
    expect(parseAnswer(text).proposal).toBeNull();
    expect(parseAnswer(text).prose).toBe(text);
  });

  it("tolerates whitespace around a marker line", () => {
    const { proposal } = parseAnswer(`  ${PROPOSAL_OPEN}  \n# Refunds\n\t${PROPOSAL_CLOSE}`);
    expect(proposal).toBe("# Refunds");
  });
});

describe("spotting a proposal in a stream that is still arriving", () => {
  it("is quiet until the block opens", () => {
    expect(proposalStarted("I have rewritten the scope section")).toBe(false);
  });

  it("fires as soon as the opening marker lands", () => {
    expect(proposalStarted(`Here goes:\n${PROPOSAL_OPEN}\n# Ref`)).toBe(true);
  });
});

describe("what the model is told about proposing", () => {
  it("quotes the markers the parser looks for", () => {
    // The prompt and the parser agreeing is the entire contract. If they drift,
    // the assistant proposes into a void and nothing anywhere reports an error.
    expect(PROPOSAL_INSTRUCTIONS).toContain(PROPOSAL_OPEN);
    expect(PROPOSAL_INSTRUCTIONS).toContain(PROPOSAL_CLOSE);
  });

  it("says the block is the whole description", () => {
    // Left out, a model sends only the section it changed and accepting deletes
    // the rest of the spec. This is the most expensive way to get it wrong.
    expect(PROPOSAL_INSTRUCTIONS).toMatch(/WHOLE description/);
  });

  it("forbids claiming the edit is done", () => {
    expect(PROPOSAL_INSTRUCTIONS).toMatch(/Never say you have made, applied or/);
  });
});
