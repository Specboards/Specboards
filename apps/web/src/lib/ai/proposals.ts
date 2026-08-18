/**
 * How the assistant offers an edit, and how we read one back out.
 *
 * ── Why a marker block and not a tool call ──────────────────────────────────
 * Function calling is the obvious mechanism and the wrong one for this product.
 * A workspace points us at any OpenAI-compatible endpoint, and the customer this
 * epic exists for is the one running a small model on their own hardware. Tool
 * calling is the least uniformly implemented part of that API: some runtimes do
 * not support it, some accept the parameter and ignore it, and small models that
 * nominally support it emit malformed calls often enough that the feature would
 * work on the models we test with and fail on the ones customers actually run.
 *
 * A marker block asks the model for something it is extremely well trained to
 * do: repeat two literal lines and put text between them. It degrades honestly
 * too. A model that ignores the instruction writes an ordinary answer, which is
 * exactly what the assistant did before proposals existed, rather than producing
 * a broken call the person has to interpret.
 *
 * ── Why the proposal is a whole body, not a patch ───────────────────────────
 * Asking a model for a diff means asking it to count lines and reproduce context
 * exactly, which is the thing models are worst at, and a patch that does not
 * apply is a failure with nothing to show the reader. A whole body always
 * applies. The diff a person reviews is then computed here, from two documents
 * we hold, so what they are shown is arithmetic rather than the model's account
 * of its own edit.
 *
 * The cost is that a model which paraphrases the parts it was not asked to
 * change will show those as edits. That is the right way round: the reader sees
 * it and can reject, where the other failure mode is silent.
 *
 * This module is pure, and it is used on both sides: the browser parses the
 * stream as it arrives, the server parses it again before persisting. One parser
 * means the panel can never disagree with the database about whether a message
 * contains a proposal.
 */

/** Opens a proposed replacement body. Must be alone on its line. */
export const PROPOSAL_OPEN = "<<<BEGIN PROPOSED SPEC>>>";
/** Closes it. */
export const PROPOSAL_CLOSE = "<<<END PROPOSED SPEC>>>";

export interface ParsedAnswer {
  /** Everything the model said outside the block, which is what gets rendered
   * as the message. Empty when the answer was nothing but a proposal. */
  prose: string;
  /** The proposed replacement body, or null when there is no usable proposal. */
  proposal: string | null;
}

/**
 * A fence the model wrapped the block in. Models are strongly inclined to put
 * anything that looks like a document inside a code fence, and stripping it is
 * kinder than adding a rule to the prompt that they will sometimes ignore.
 */
const FENCE = /^(?:`{3,}|~{3,})[^\n]*$/;

/**
 * Split an answer into what to show and what is being proposed.
 *
 * Deliberately lenient, because the alternative to leniency is a customer whose
 * small model formats the block *almost* right and gets no proposal with no
 * explanation:
 *
 * - A missing closing marker takes the rest of the message. A model that opened
 *   the block and then hit its token limit has still told us what it wants; the
 *   truncation shows up in the diff, where the reader can see it.
 * - A block wrapped in a code fence has the fence removed.
 * - An empty block is no proposal. A model that emitted the markers around
 *   nothing did not mean "delete this item's entire description", and treating
 *   it as if it did would put a destructive edit in front of someone as a
 *   one-click accept.
 * - Several blocks: the first is the proposal, and the rest are dropped from the
 *   prose rather than left in it as literal marker text.
 */
export function parseAnswer(text: string): ParsedAnswer {
  const lines = text.split("\n");
  const prose: string[] = [];
  let proposal: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trim() !== PROPOSAL_OPEN) {
      prose.push(lines[i]!);
      i++;
      continue;
    }
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== PROPOSAL_CLOSE) {
      body.push(lines[i]!);
      i++;
    }
    // Past the closing marker, or past the end when there was not one.
    i++;
    if (proposal === null) {
      const stripped = stripFence(body).join("\n").trim();
      if (stripped) proposal = stripped;
    }
  }

  return { prose: prose.join("\n").trim(), proposal };
}

/** Drop a code fence the model wrapped the body in, if it wrapped the whole. */
function stripFence(body: string[]): string[] {
  let start = 0;
  let end = body.length;
  while (start < end && body[start]!.trim() === "") start++;
  while (end > start && body[end - 1]!.trim() === "") end--;
  if (end - start >= 2 && FENCE.test(body[start]!.trim()) && FENCE.test(body[end - 1]!.trim())) {
    return body.slice(start + 1, end - 1);
  }
  return body.slice(start, end);
}

/**
 * Whether an answer that is still arriving has opened a block.
 *
 * The panel uses this to stop rendering the raw stream as Markdown the moment a
 * proposal starts: a half-arrived spec body scrolling past as prose looks like
 * the assistant has lost the thread, and the marker lines look like a fault.
 */
export function proposalStarted(partial: string): boolean {
  return partial.includes(PROPOSAL_OPEN);
}

/**
 * The standing instruction that teaches the model to propose.
 *
 * Written as rules with reasons rather than as a template, because the models
 * this has to work on range from frontier to 7B and the small ones follow a
 * short list of literal rules far better than they follow an example they are
 * meant to generalise from.
 *
 * The last rule is the one that matters most and it is stated as fact rather
 * than as instruction: a model that believes its edit has already landed writes
 * "I've updated the spec", and the person reads that as done and never clicks
 * accept. That is the failure that makes the whole feature untrustworthy.
 */
export function proposalInstructions(owner: string, noun: string): string {
  return [
    `You can propose a change to ${owner} ${noun}. Do it when you are`,
    "asked to write, rewrite, add to, tidy or fill in part of it. Do not do it",
    "when you were asked a question: answer the question instead.",
    "",
    "To propose, end your reply with exactly this, on its own lines:",
    "",
    PROPOSAL_OPEN,
    `the complete new ${noun}, in Markdown`,
    PROPOSAL_CLOSE,
    "",
    "Rules for that block:",
    `- It must contain the WHOLE ${noun} as you want it to end up, not just`,
    "  the part you changed. Anything you leave out is being deleted.",
    "- Keep every part you were not asked to change exactly as it is, word for",
    "  word. The person is shown a line-by-line diff, and rephrasing something",
    "  nobody asked you to touch wastes their attention on your paraphrase.",
    "- No YAML frontmatter, no surrounding code fence, no commentary inside it.",
    "- Before the block, say in one or two sentences what you changed and why.",
    "  Do not repeat it there.",
    "",
    "Proposing is not editing. Your proposal is shown to a person as a diff and",
    "changes nothing unless they accept it. Never say you have made, applied or",
    "saved a change.",
  ].join("\n");
}

/**
 * `owner` and `noun` are separate because the sentences need them separately:
 * "a change to this item's description" wants the possessive and "the WHOLE
 * description" must not have it. One combined string produced "the WHOLE this
 * item's description", which is the kind of prompt wording that makes a small
 * model stop following the rule it appears in.
 */

/**
 * The instructions for an item's description, which is what this started as.
 *
 * The markers themselves stay the literal strings above on every surface, even
 * where the word "SPEC" is not quite the right noun. They are a wire format
 * rather than prose: one pair of markers means one parser, and one parser is
 * what lets the browser and the server never disagree about whether a message
 * contains a proposal. A per-surface marker would double that parser and buy a
 * word nobody reads.
 */
export const PROPOSAL_INSTRUCTIONS = proposalInstructions("this item's", "description");
