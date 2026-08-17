/**
 * Reading a proposed decomposition back out of a model's answer.
 *
 * ── Why a list and not one card at a time ───────────────────────────────────
 * The question a breakdown answers is "does this cover the parent", and that is
 * only answerable by seeing the set. Proposing one child, accepting it, and
 * asking for the next is a different and much worse activity: each card looks
 * reasonable on its own and nobody ever sees the gap. So the model is asked for
 * the whole decomposition and the person reviews it as a whole.
 *
 * ── Why the same marker shape as a spec proposal ────────────────────────────
 * Deliberately the same envelope as `proposals.ts`, for the same reason it was
 * chosen there: it is the thing every model, down to a 7B running on somebody's
 * own hardware, is best at reproducing, and a model that ignores it writes an
 * ordinary answer rather than a broken tool call. Two different envelopes for
 * two kinds of proposal would be two things to get wrong.
 *
 * Pure: no database, no network, no environment.
 */

/** Opens a proposed set of child items. Must be alone on its line. */
export const BREAKDOWN_OPEN = "<<<BEGIN PROPOSED BREAKDOWN>>>";
/** Closes it. */
export const BREAKDOWN_CLOSE = "<<<END PROPOSED BREAKDOWN>>>";

/** One proposed child, before anybody has agreed to it. */
export interface ProposedChild {
  title: string;
  /** What it covers. May be empty; a title alone is still a usable card. */
  details: string;
}

export interface ParsedBreakdown {
  /** What the model said outside the block, shown above the list. */
  prose: string;
  /** The proposed children, in the order given. Empty when there is none. */
  children: ProposedChild[];
}

/**
 * Most a single breakdown will offer.
 *
 * Not a guess at the right size of a decomposition, which is the team's
 * business. It is a backstop: a model that misreads the instruction and starts
 * enumerating can otherwise put a hundred tick boxes in front of someone, and
 * an accidental "accept all" would then create a hundred cards that have to be
 * deleted one at a time.
 */
export const MAX_PROPOSED_CHILDREN = 20;

/** Longest title accepted, matching what a card can sensibly show. */
export const MAX_CHILD_TITLE_CHARS = 200;

/** A bullet or a numbered item: `- x`, `* x`, `+ x`, `1. x`, `1) x`. */
const ITEM_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * `**Title**: the rest`, which models produce constantly whatever the prompt
 * says. Splitting it is kinder than adding another rule they will ignore, and
 * the alternative is a card literally titled "**Ship the thing**: covers ...".
 */
const BOLD_TITLE = /^\*\*(.+?)\*\*\s*[:.—-]?\s*(.*)$/;

/**
 * Split an answer into what to show and what is being proposed.
 *
 * Lenient in the same places {@link parseAnswer} is, and for the same reason: a
 * small model that formats the block *almost* right must not produce silence.
 * A missing closing marker takes the rest of the message; a code fence around
 * the list is ignored; anything that is not a recognisable list item is treated
 * as description text for the item above it.
 */
export function parseBreakdown(text: string): ParsedBreakdown {
  const lines = text.split("\n");
  const prose: string[] = [];
  const body: string[] = [];
  let inside = false;
  let seen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === BREAKDOWN_OPEN) {
      inside = true;
      seen = true;
      continue;
    }
    if (trimmed === BREAKDOWN_CLOSE) {
      inside = false;
      continue;
    }
    if (inside) body.push(line);
    else prose.push(line);
  }

  return {
    prose: prose.join("\n").trim(),
    children: seen ? collect(body) : [],
  };
}

/** Turn the block's lines into items, attaching stray lines as description. */
function collect(lines: string[]): ProposedChild[] {
  const out: ProposedChild[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // A fence the model wrapped the list in carries no content.
    if (!trimmed || /^(?:`{3,}|~{3,})/.test(trimmed)) continue;

    const item = ITEM_LINE.exec(line);
    if (!item) {
      // Not a new item: continuation of the one above. Before the first item it
      // is preamble the model put inside the block, which is not a card.
      const last = out.at(-1);
      if (last) {
        last.details = last.details ? `${last.details} ${trimmed}` : trimmed;
      }
      continue;
    }
    if (out.length >= MAX_PROPOSED_CHILDREN) break;

    const rest = item[1]!.trim();
    const bold = BOLD_TITLE.exec(rest);
    const title = (bold ? bold[1]! : rest).trim().slice(0, MAX_CHILD_TITLE_CHARS);
    if (!title) continue;
    out.push({ title, details: (bold ? bold[2]! : "").trim() });
  }
  return out;
}

/**
 * The instruction that asks for a decomposition.
 *
 * `childLabel` is the workspace's own word for the level below this item, not
 * ours. Levels are configurable, and a proposal that invents a level nobody has
 * would fail on create with a message about a level key the person has never
 * seen. Naming it in the prompt also keeps the model from proposing a mixture
 * of sizes, which is the usual failure: half epics and half individual tickets.
 *
 * `existing` is what is already under the parent. Asking for the gap rather
 * than the whole decomposition is the difference between a button you can press
 * twice and one you can press once: without it a re-run proposes the children
 * that are already there, and the reviewer has to work out which is which.
 */
export function breakdownInstructions(
  childLabel: string,
  existing: string[],
): string {
  const label = childLabel.trim() || "child";
  const lines = [
    `Your task is to break this item down into ${label} items: the level`,
    "immediately below it. Propose the set that covers the parent, and nothing",
    "at a different size. Every one you propose has to be work that could be",
    "picked up on its own.",
    "",
    "Answer with a short sentence about how you divided it, then exactly this:",
    "",
    BREAKDOWN_OPEN,
    "- A title, on one line, in plain text",
    "  One or two sentences on what it covers.",
    "- The next title",
    "  What that one covers.",
    BREAKDOWN_CLOSE,
    "",
    "Rules for that block:",
    "- One bullet per item. Title on the bullet line, nothing else on it: no",
    "  bold, no colon, no size estimate, no numbering of your own.",
    "- Put the description on the following line, indented. Keep it to what",
    "  the item covers, not why it matters.",
    "- Propose only what is genuinely missing. Do not restate the parent.",
    `- Between three and eight items is usual. Fewer is fine if the parent is`,
    "  small. Do not pad the list to reach a number.",
  ];

  if (existing.length > 0) {
    lines.push(
      "",
      `This item already has ${label} items under it, listed above as Child`,
      "items. Propose only what is missing beside them. Do not propose",
      "anything that duplicates or renames one that is already there, and if",
      "the breakdown already looks complete, say so and propose nothing.",
    );
  }

  lines.push(
    "",
    "Nothing you propose is created until a person ticks it and accepts. Do",
    "not say you have created anything.",
  );
  return lines.join("\n");
}
