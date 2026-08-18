/**
 * Turn a release into the context the assistant is given about it.
 *
 * The sibling of `item-context.ts`, and it keeps that module's central promise:
 * the prompt is *derived from* {@link AssembledReleaseContext.fields}, and those
 * same fields are what the UI discloses. There is no path that puts something in
 * the request without putting it in the disclosure.
 *
 * ── Why this is a separate module and not a flag on item-context ────────────
 * The two send different facts and ask for entirely different things, and the
 * standing role is the clearest example: "you are helping someone think about
 * one specific item" is exactly wrong here and cannot be undone downstream. A
 * function whose role text, rules and field list all branch on a boolean is one
 * nobody can read, and the first thing to rot in it would be the disclosure.
 *
 * ── What is deliberately NOT sent ───────────────────────────────────────────
 * - **People.** No assignee, no author, no member list. Same reasoning as on an
 *   item: names are personal data and knowing who built something does not make
 *   the notes better.
 * - **Internal planning notes.** `releases.notes` is where a team writes things
 *   like "slipping because the vendor is late". It is not customer-facing and
 *   this is the one surface whose output is.
 * - **Anything from settings.** No credentials, no repo contents, no URLs.
 *
 * ── What IS sent, and why it is a lot ───────────────────────────────────────
 * Every item's description, not just its title. Customers asked for this
 * explicitly, and the reason is visible in the output: from titles alone a model
 * has to guess what "Single sign-on" meant for a customer, and guessing is
 * exactly how an invented release note gets written.
 *
 * It is a real change in what leaves the building, and it is not hidden: one
 * question about one release now sends that release's work to the customer's
 * provider in a single request. The disclosure lists it, item by item, before
 * anyone spends a token, which is the whole reason the disclosure is the input
 * to the request rather than a description of it.
 *
 * The budget below is not a way to soften that. It is a context window: a
 * forty-item release at full description length does not fit in a small
 * self-hosted model, and the choice is between shortening deliberately and
 * failing with a 400 nobody can act on. What it must never do is shorten
 * silently, so every cut is announced in the prompt and reported to the UI.
 *
 * This module is pure: no database, no network, no environment. That is what
 * makes "here is exactly what leaves the building" a testable claim rather than
 * a comment.
 */

import type { ContextField } from "./item-context";
import { proposalInstructions } from "./proposals";
import { skillTask, type SkillDef } from "./skills";

/** One item in the release, as the prompt names it. */
export interface ReleaseContextItem {
  title: string;
  statusLabel: string;
  /** The item's Markdown body. Empty for an item nobody has written up, which
   * is common and is exactly what "Needs a description" in the drafting skill
   * is there to surface. */
  description: string;
}

/** One level's worth of the release's items, in hierarchy order. */
export interface ReleaseContextGroup {
  /** The workspace's own word for the level ("Epic"), not a key: levels are
   * configurable and the notes should use the customer's language. */
  levelLabel: string;
  items: ReleaseContextItem[];
}

export interface ReleaseContextInput {
  name: string;
  /** The workflow's label for the release's state, for the same reason the
   * level label is a label. */
  statusLabel: string;
  targetDate: string | null;
  shippedDate: string | null;
  /** The work scheduled into the release, grouped by level, top level first.
   * Already filtered to what the caller may read. */
  groups: ReleaseContextGroup[];
  /**
   * The customer-facing notes as they stand, which is what a proposal replaces.
   * Empty when nobody has written any yet, which is the ordinary starting case
   * and the one the drafting skill exists for.
   */
  notesBody: string;
  /**
   * Whether this person may change the release. False turns off the proposal
   * instructions entirely, so a reader is never offered an edit they would be
   * refused when they clicked accept. Told to the model rather than only hidden
   * in the UI: a model that has been told it can propose will keep offering to,
   * and "shall I write those up for you?" from something that cannot is worse
   * than never mentioning it.
   */
  canEdit: boolean;
}

export interface AssembledReleaseContext {
  /** The system turn. Built from `fields` and nothing else. */
  systemPrompt: string;
  /** Exactly what the prompt was built from, in the order it appears in it. */
  fields: ContextField[];
  /** How many items made it into the prompt. */
  itemsIncluded: number;
  /**
   * How many were dropped for budget. Non-zero is worth saying out loud in the
   * UI: notes drafted from two thirds of a release are missing a third of it,
   * and that is not something a reader can infer from the prose.
   */
  itemsOmitted: number;
  /** How many items' descriptions were sent, whole or shortened. */
  descriptionsIncluded: number;
  /**
   * How many of those were shortened to fit. Reported rather than left implicit
   * because it is the one thing a reader cannot tell from the draft: notes
   * written from the first paragraph of every spec look exactly like notes
   * written from all of them.
   */
  descriptionsShortened: number;
  /**
   * Whether the model was actually invited to propose. False for someone who
   * cannot write the release, and false when the existing notes were too long
   * to send whole, which is the case worth naming: a whole-body replacement
   * drafted from a shortened document deletes everything past the cut.
   */
  canPropose: boolean;
}

/**
 * Character budget for the item list.
 *
 * Characters rather than tokens, for the reason `item-context.ts` gives: we
 * support any endpoint a customer points us at, so counting tokens would mean
 * shipping a tokenizer per model and still being wrong for the local runtime
 * nobody told us about.
 *
 * Set well below the item-context body limit on purpose. This list is the whole
 * prompt rather than one field in it, and the customer this has to work for is
 * the one running a small model on their own hardware: a release with two
 * hundred items must produce a request that endpoint can actually answer, not a
 * 400 from a context window it blew through.
 */
export const ITEM_LIST_CHAR_LIMIT = 24_000;

/**
 * Most of one item's description that is ever sent, however small the release.
 *
 * Without a per-item cap, a release holding three items would give each of them
 * eight thousand characters, and a single rambling spec would crowd out the
 * other two. Nobody writing release notes needs the whole of a design document;
 * they need what the change was.
 */
export const MAX_ITEM_DESCRIPTION_CHARS = 2_000;

/**
 * Least useful slice of a description.
 *
 * Below this the descriptions are dropped for every item rather than shared out,
 * and the prompt goes back to titles and statuses. Hundred-character fragments
 * of three hundred specs are worse than no descriptions at all: each one stops
 * mid-sentence, and a model handed three hundred sentence fragments writes
 * confident nonsense from them. Titles at least do not pretend to be complete.
 */
export const MIN_ITEM_DESCRIPTION_CHARS = 240;

/** Per-description cost beyond its own characters: indent, ellipsis, newline. */
const DESCRIPTION_OVERHEAD_CHARS = 4;

/**
 * The assistant's standing instructions on a release.
 *
 * The audience is the difference that matters. Point the item-panel role at a
 * release and it writes an internal changelog: accurate, addressed to the team,
 * and useless to publish. Saying who is going to read this, in the first
 * sentence, is what stops that.
 */
const ROLE = [
  "You are a product assistant inside Specboards, a tool where teams plan",
  "product work and ship it in releases. You are helping someone write the",
  "customer-facing release notes for one release, described below.",
  "",
  "The audience is the people who use the product, not the team that built it.",
  "They do not know your internal names for things, they did not read the",
  "tickets, and they care what changed for them.",
].join(" ");

/**
 * What the model is told about its own reach.
 *
 * Stated as plainly as on an item, and for the same reason: a model with no rule
 * about writing will happily answer "I have published the notes for you", and
 * the person will believe it.
 */
const READ_ONLY = [
  "You cannot change anything. You have no tools and no write access: nothing",
  "you say is saved unless a person does it themselves. Do not claim to have",
  "saved or published anything.",
].join(" ");

/** How the model is invited to propose the notes themselves. */
const PROPOSAL_RULES = proposalInstructions("this release's", "notes");

/**
 * What a model is told when the existing notes were too long to send whole.
 *
 * The same trap as on an item, and the same answer. A proposal is a whole
 * replacement document, so a model shown the first few thousand characters of
 * the notes and asked to tighten them proposes those characters back, and
 * accepting deletes the rest. The offer is withdrawn rather than qualified,
 * because a model that has been told it may propose will propose.
 */
const TOO_LONG_TO_PROPOSE = [
  "You cannot propose a change to these notes, because you have not been shown",
  "all of them: they were too long to send. Suggest wording in your reply for",
  "the person to apply themselves, and say why you cannot propose it directly",
  "if they ask for an edit. Do not claim to have made a change.",
].join(" ");

/**
 * Longest existing notes body sent whole.
 *
 * Past this the notes are shortened and proposing is withdrawn. Set below the
 * item body limit because the item list has to fit alongside it: a release with
 * both a long document and a hundred items is exactly the request that would
 * otherwise blow a small model's window.
 */
export const NOTES_CHAR_LIMIT = 6_000;

/**
 * Assemble the context for one release.
 *
 * Absent values are omitted rather than sent as "none", for the reason the item
 * assembler gives: a field saying "Shipped: none" is noise in the prompt and,
 * worse, a line in the disclosure claiming we sent something we did not.
 */
export function assembleReleaseContext(
  input: ReleaseContextInput,
  /**
   * The skill in force, if any. A parameter rather than a field on the input
   * because it is not a fact about the release, and the disclosure lists facts
   * about the release. It is an instruction, and it belongs with the other
   * instructions.
   */
  skill?: SkillDef | null,
): AssembledReleaseContext {
  const fields: ContextField[] = [
    { label: "Release", value: input.name.trim() },
    { label: "Status", value: input.statusLabel.trim() },
  ];

  if (input.shippedDate) {
    fields.push({ label: "Shipped", value: input.shippedDate });
  } else if (input.targetDate) {
    fields.push({ label: "Target date", value: input.targetDate });
  }

  const { value, included, omitted, described, shortened } = renderItems(
    input.groups,
  );
  if (included > 0) {
    fields.push({
      label: "Work in this release",
      value,
      truncated: omitted > 0,
    });
  }

  // Last, so the document being edited sits nearest the answer. Omitted when
  // empty rather than sent as a blank field: "there are no notes yet" is what
  // the absence of this says, and a field saying so is a line in the disclosure
  // claiming we sent something we did not.
  const notes = input.notesBody.trim();
  let sawWholeNotes = true;
  if (notes) {
    const cut = notes.length > NOTES_CHAR_LIMIT;
    sawWholeNotes = !cut;
    fields.push({
      label: "Current release notes",
      value: cut ? notes.slice(0, NOTES_CHAR_LIMIT) : notes,
      truncated: cut,
    });
  }

  const canPropose = input.canEdit && sawWholeNotes;
  const rules = !input.canEdit
    ? READ_ONLY
    : sawWholeNotes
      ? PROPOSAL_RULES
      : TOO_LONG_TO_PROPOSE;

  return {
    systemPrompt: renderPrompt(
      fields,
      rules,
      skill ? task(skill, canPropose) : null,
    ),
    fields,
    itemsIncluded: included,
    itemsOmitted: omitted,
    descriptionsIncluded: described,
    descriptionsShortened: shortened,
    canPropose,
  };
}

/**
 * A running skill's block, with a backstop when it asks for something this
 * conversation cannot do.
 *
 * A skill is free text a customer wrote, and the one we ship says in as many
 * words "propose them as the release notes". Run it on a release the reader
 * cannot write, or against notes too long to send whole, and the prompt would
 * carry both "you cannot propose" and "propose" with nothing to break the tie.
 * The reminder goes after the skill, because the instruction nearest the end is
 * the one a small model follows, and here that has to be ours.
 */
function task(skill: SkillDef, canPropose: boolean): string {
  if (canPropose) return skillTask(skill);
  return [
    skillTask(skill),
    "",
    "Whatever that task says: you cannot change this release and cannot propose",
    "a change to its notes in this conversation. Where the task asks you to write",
    "or apply one, put the wording in your reply for a person to use, and say",
    "that you cannot apply it yourself.",
  ].join("\n");
}

/**
 * How much of each description survives, decided once for the whole release.
 *
 * One share for every item rather than first-come-first-served, because the
 * alternative reads as a bug: the first few items arrive complete and the rest
 * are stubs, so whichever epic happens to sort first looks like the important
 * one. An even share is explicable in a sentence, which is what the disclosure
 * has to say.
 *
 * Returns 0 when the share would be too small to be worth sending, which is the
 * honest outcome for a release with hundreds of items: see
 * {@link MIN_ITEM_DESCRIPTION_CHARS}.
 */
export function descriptionShare(
  itemsWithDescriptions: number,
  budget: number,
): number {
  if (itemsWithDescriptions <= 0) return 0;
  // Each description costs a little more than its own characters: two for the
  // indent, one for the ellipsis when it is cut, one for the line break. Taken
  // off before dividing so the share is what actually fits. A multi-line body
  // costs two more per line again, which cannot be known here, and that is what
  // the titles-first backstop in `renderItems` is for.
  const spendable = budget - itemsWithDescriptions * DESCRIPTION_OVERHEAD_CHARS;
  const share = Math.floor(spendable / itemsWithDescriptions);
  if (share < MIN_ITEM_DESCRIPTION_CHARS) return 0;
  return Math.min(share, MAX_ITEM_DESCRIPTION_CHARS);
}

/**
 * The item list, cut to fit the budget.
 *
 * Titles are paid for first and descriptions get what is left. That order is the
 * whole design: a title identifies work that shipped, so losing one loses a
 * change from the notes entirely, while losing a description costs detail about
 * a change that is still mentioned. Given a release too big for both, the notes
 * that name everything thinly beat the notes that describe a third of it well.
 *
 * Items are still cut by whole items rather than by characters, for the reason
 * they always were: a list that stops mid-title invites the model to complete
 * it, and a completed title is an invented feature. The cut runs level by level
 * in hierarchy order, so what survives is the top of the release.
 */
function renderItems(groups: readonly ReleaseContextGroup[]): {
  value: string;
  included: number;
  omitted: number;
  /** How many descriptions were sent, whole or shortened. */
  described: number;
  /** How many of those were shortened to fit. */
  shortened: number;
} {
  const all = groups.flatMap((g) => g.items);

  // Titles first, so the description budget is what is genuinely left over.
  const titleCost = groups.reduce(
    (sum, g) =>
      sum +
      (g.items.length > 0 ? g.levelLabel.length + 2 : 0) +
      g.items.reduce(
        (n, i) => n + i.title.trim().length + i.statusLabel.trim().length + 6,
        0,
      ),
    0,
  );
  const share = descriptionShare(
    all.filter((i) => i.description.trim()).length,
    ITEM_LIST_CHAR_LIMIT - titleCost,
  );

  const lines: string[] = [];
  let used = 0;
  let included = 0;
  let omitted = 0;
  let described = 0;
  let shortened = 0;
  let full = false;

  for (const group of groups) {
    const heading = `${group.levelLabel}:`;
    let headingWritten = false;

    for (const item of group.items) {
      if (full) {
        omitted += 1;
        continue;
      }
      const line = `- ${item.title.trim()} (${item.statusLabel.trim()})`;

      const body = item.description.trim();
      let detail = "";
      let cut = false;
      // Both are reassigned below when a description has to be dropped to keep
      // its title.
      if (share > 0 && body) {
        cut = body.length > share;
        // Indented under its item, and marked when shortened, so the model can
        // see which descriptions it has only part of rather than reading a
        // truncated one as complete.
        const text = cut ? `${body.slice(0, share)}…` : body;
        detail = text
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n");
      }

      const headingCost = headingWritten ? 0 : heading.length + 1;
      const titleCost = line.length + 1 + headingCost;
      let cost = titleCost + (detail ? detail.length + 1 : 0);

      // Titles are paid first, and this is where that is actually enforced
      // rather than estimated. The share above is arithmetic on lengths that do
      // not quite match what the lines cost once indented, so without this the
      // overshoot lands on the last item and drops it entirely: a change
      // vanishes from the notes to buy detail about the ones before it. Drop
      // the detail instead, and only then the item.
      if (detail && used + cost > ITEM_LIST_CHAR_LIMIT) {
        detail = "";
        cut = false;
        cost = titleCost;
      }
      if (used + cost > ITEM_LIST_CHAR_LIMIT) {
        // Everything after this is dropped, including the rest of this group.
        // Continuing to look for a short enough item would produce a list whose
        // gaps are invisible: the reader sees a plausible release with some of
        // its middle missing.
        full = true;
        omitted += 1;
        continue;
      }
      if (!headingWritten) {
        lines.push(heading);
        headingWritten = true;
      }
      lines.push(line);
      if (detail) {
        lines.push(detail);
        described += 1;
        if (cut) shortened += 1;
      }
      used += cost;
      included += 1;
    }
  }

  return { value: lines.join("\n"), included, omitted, described, shortened };
}

/**
 * Render the fields into the system turn.
 *
 * Truncation is announced in the prompt itself, not only in the UI. A model
 * given two thirds of a release with no indication writes confidently about a
 * release it has not seen all of, and the person reading that draft has no way
 * to tell.
 */
function renderPrompt(
  fields: readonly ContextField[],
  rules: string,
  task: string | null = null,
): string {
  const rendered = fields.map((f) => {
    const note = f.truncated
      ? " (shortened; you have not been shown every item in this release)"
      : "";
    return f.value.includes("\n")
      ? `${f.label}${note}:\n${f.value}`
      : `${f.label}${note}: ${f.value}`;
  });
  // Role, then what you may and may not do, then the job, then the thing
  // itself. The same order as the item prompt, and for the same reason: the
  // rule that must survive is the one saying nothing here is saved, and
  // instructions that follow a long document are the first a small model loses.
  const head = task ? `${ROLE}\n\n${rules}\n\n${task}` : `${ROLE}\n\n${rules}`;
  return `${head}\n\n---\n\n${rendered.join("\n\n")}`;
}
