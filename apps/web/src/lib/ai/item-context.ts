/**
 * Turn an item into the context the assistant is given about it.
 *
 * ── Why this returns the disclosure as well as the prompt ───────────────────
 * The feature this implements asks for "an explicit and reviewable decision
 * about what is sent to the customer's provider". The obvious way to satisfy
 * that is a paragraph in the UI listing what we send. The obvious way for it to
 * become a lie is for someone to add a field to the prompt and not to the
 * paragraph.
 *
 * So the prompt is *derived from* {@link AssembledContext.fields}, and those
 * same fields are what the UI shows. There is no path that puts something in
 * the request without putting it in the disclosure, because the disclosure is
 * the input to the request rather than a description of it.
 *
 * ── What is deliberately NOT sent ───────────────────────────────────────────
 * - **People.** No assignee, no author, no member list, no email addresses.
 *   Names are personal data, the endpoint belongs to a third party we have no
 *   relationship with, and knowing who a card is assigned to does not make a
 *   definition better. Mentioned only if the body itself names someone, which
 *   is the customer's own text and their decision.
 * - **Other items.** Only this item, its parent's title, and its children's
 *   titles. Sending the sibling backlog would help occasionally and would mean
 *   a question about one card ships the whole product plan to an endpoint.
 * - **Anything from settings.** No credentials, no repo contents, no URLs.
 *
 * This module is pure: no database, no network, no environment. That is what
 * makes "here is exactly what leaves the building" a testable claim rather than
 * a comment.
 */

import { breakdownInstructions } from "./breakdown";
import { PROPOSAL_INSTRUCTIONS } from "./proposals";
import { skillTask, type SkillDef } from "./skills";

/** One labelled thing that goes into the prompt, and into the disclosure. */
export interface ContextField {
  /** Shown to the user in the "what is sent" list. */
  label: string;
  /** The value as it appears in the prompt. */
  value: string;
  /** Set when the value was shortened, so the UI can say so rather than
   * implying the model saw the whole thing. */
  truncated?: boolean;
}

export interface ItemContextInput {
  title: string;
  /**
   * Whether this person may change the item. False turns off the proposal
   * instructions entirely, so a reader with no write access is never offered an
   * edit they would be refused when they clicked accept. Telling the model
   * instead of hiding the button matters: a model that has been told it can
   * propose will keep offering to, and "shall I draft that for you?" from
   * something that cannot is worse than never mentioning it.
   */
  canEdit: boolean;
  /** The workspace's own word for this level ("Epic", "Feature"), not a key:
   * levels are configurable and the model should use the customer's language. */
  levelLabel: string;
  /** The workflow's label for the status, for the same reason. */
  statusLabel: string;
  /** Spec body or card details. May be empty. */
  body: string;
  parentTitle: string | null;
  parentLevelLabel: string | null;
  children: { title: string; statusLabel: string }[];
  /** Titles of goals this item ladders up to. */
  goals: string[];
  tags: string[];
}

export interface AssembledContext {
  /** The system turn. Built from `fields` and nothing else. */
  systemPrompt: string;
  /** Exactly what the prompt was built from, in the order it appears in it. */
  fields: ContextField[];
  /**
   * Whether the model was actually invited to propose an edit. False when the
   * caller cannot write, and false when the description was too long to send
   * whole, which is the case worth naming: a whole-body replacement drafted
   * from a shortened description deletes everything past the cut.
   */
  canPropose: boolean;
}

/**
 * Character budgets, not token budgets.
 *
 * Tokenization is model-specific and we support any endpoint a customer points
 * us at, so counting tokens here would mean shipping a tokenizer per model and
 * still being wrong for the local runtime nobody told us about. Characters are
 * a coarse but honest proxy, and the failure mode of being too generous is a
 * clear error from the endpoint rather than a silently mangled answer.
 *
 * The body limit is set so a full spec usually survives intact while still
 * leaving room in a small local model's window, since a customer running a
 * 4k-context model on their own hardware is a case this epic exists to serve.
 */
export const BODY_CHAR_LIMIT = 8_000;
/** Enough to show the shape of a decomposition; a long list stops informing. */
export const CHILD_LIMIT = 40;

/**
 * Whether a description was small enough to send whole.
 *
 * The single definition of that question, used both when assembling the prompt
 * and when deciding whether a proposal may be recorded or accepted. Two copies
 * of this rule that drift apart is exactly how a proposal drafted from a
 * shortened document gets an Accept button.
 */
export function bodyFitsWhole(body: string | null | undefined): boolean {
  return (body ?? "").trim().length <= BODY_CHAR_LIMIT;
}

function truncate(text: string, limit: number): { value: string; truncated: boolean } {
  if (text.length <= limit) return { value: text, truncated: false };
  return { value: text.slice(0, limit), truncated: true };
}

/**
 * The assistant's standing instructions.
 *
 * Deliberately a plain, competent baseline: the interrogation behaviour
 * ("grill me on this feature") is its own feature, where it becomes a
 * configurable skill a team can edit. Hardcoding a strong opinion here would
 * mean that feature's first job is deleting this one.
 */
const ROLE = [
  "You are a product assistant inside Specboards, a tool where teams define",
  "product work as specs. You are helping someone think about one specific",
  "item, described below.",
  "",
  "Be direct and concrete. Prefer asking one sharp question over listing ten",
  "generic ones. When the definition is vague about scope, failure cases,",
  "non-goals or how success is measured, say so plainly rather than writing",
  "around the gap.",
].join(" ");

/**
 * What a reader is told instead of the proposal instructions.
 *
 * Stated as plainly as the instructions are, and for the same reason: a model
 * with no rule about writing will happily answer "I've added that for you" and
 * the person will believe it.
 */
const READ_ONLY = [
  "You cannot change anything. You have no tools and no write access: nothing",
  "you say is applied to the item unless a person does it themselves. Do not",
  "claim to have made an edit.",
].join(" ");

/**
 * What a model is told when the description was too long to send whole.
 *
 * ── The bug this prevents ───────────────────────────────────────────────────
 * A proposal is a *whole replacement body*. A model shown the first eight
 * thousand characters of a spec and asked to rewrite it will propose those
 * eight thousand characters back, and accepting that deletes the rest. The diff
 * would show the deletion, so a careful reviewer would catch it, but the trap
 * is that nothing about the situation looks unusual: the assistant did as it
 * was asked, and the reviewer is reading the change they requested rather than
 * auditing the end of a document they have already read.
 *
 * So the offer is withdrawn rather than qualified. A model that has been told
 * it may propose will propose, and a rule saying "but not if you were given a
 * shortened description" is one more thing for a small model to get wrong at
 * exactly the moment the cost is highest.
 */
const TOO_LONG_TO_PROPOSE = [
  "You cannot propose an edit to this item, because you have not been shown",
  "all of its description: it was too long to send. Suggest wording in your",
  "reply for the person to apply themselves, and say why you cannot propose it",
  "directly if they ask for an edit. Do not claim to have made a change.",
].join(" ");

/**
 * Assemble the context for one item.
 *
 * Absent and empty values are omitted rather than sent as "none": a field that
 * says "Parent: none" is noise in the prompt and, worse, a line in the
 * disclosure claiming we sent something we did not.
 */
export function assembleItemContext(
  input: ItemContextInput,
  /**
   * The skill in force, if any: a team's own standing instructions for the job
   * being done right now ("Grill me", "Find the gaps").
   *
   * A parameter rather than a field on the input because it is not a fact about
   * the item, and the disclosure lists facts about the item. It is an
   * instruction, and it belongs with the other instructions, which is exactly
   * where {@link renderPrompt} puts it.
   */
  skill?: SkillDef | null,
): AssembledContext {
  const fields = buildFields(input);

  // A shortened description cannot be safely rewritten; see TOO_LONG_TO_PROPOSE.
  // Derived from the same predicate the persist and accept paths use, rather
  // than from the assembled fields, so all three agree by construction.
  const sawWholeBody = bodyFitsWhole(input.body);
  const rules = !input.canEdit
    ? READ_ONLY
    : sawWholeBody
      ? PROPOSAL_INSTRUCTIONS
      : TOO_LONG_TO_PROPOSE;
  const canPropose = input.canEdit && sawWholeBody;
  return {
    systemPrompt: renderPrompt(
      fields,
      rules,
      skill ? task(skill, canPropose) : null,
    ),
    fields,
    canPropose,
  };
}

/**
 * A running skill's block, with a backstop when it is asking for something this
 * conversation cannot do.
 *
 * A skill is free text a customer wrote, and one of the three we ship says in as
 * many words "propose it as an edit". Run it on an item the reader cannot write,
 * or on a description too long to send whole, and the prompt would carry both
 * "you cannot propose an edit" and "propose an edit" with nothing to break the
 * tie. The reminder goes *after* the skill rather than before it, because the
 * instruction nearest the end is the one a small model follows, and here that
 * has to be ours.
 */
function task(skill: SkillDef, canPropose: boolean): string {
  if (canPropose) return skillTask(skill);
  return [
    skillTask(skill),
    "",
    "Whatever that task says: you cannot change this item and cannot propose an",
    "edit in this conversation. Where the task asks you to write or apply one,",
    "put the wording in your reply for a person to use, and say that you cannot",
    "apply it yourself.",
  ].join("\n");
}

/**
 * The same item, described for a different job: proposing the level below it.
 *
 * A sibling of {@link assembleItemContext} rather than a flag on it, because
 * the two send the same facts and ask for entirely different things, and a
 * function whose instructions branch four ways is one nobody can read. What
 * they share is what matters: the same field list, so the disclosure stays
 * true, and the same renderer, so neither can quietly start sending something
 * the other does not.
 *
 * Truncation of the description is not a problem here the way it is for an
 * edit. A breakdown proposes new items rather than replacing the body, so a
 * shortened description costs a little context and cannot delete anything.
 */
export function assembleBreakdownContext(
  input: ItemContextInput,
  childLevelLabel: string,
): AssembledContext {
  const fields = buildFields(input);
  return {
    systemPrompt: renderPrompt(
      fields,
      breakdownInstructions(
        childLevelLabel,
        input.children.map((c) => c.title),
      ),
    ),
    fields,
    // Not a proposal-to-the-body task at all; the flag is about spec edits.
    canPropose: false,
  };
}

/** The facts about the item, in the order they appear in the prompt. */
function buildFields(input: ItemContextInput): ContextField[] {
  const fields: ContextField[] = [];

  fields.push({ label: "Title", value: input.title.trim() });
  fields.push({ label: "Level", value: input.levelLabel.trim() });
  fields.push({ label: "Status", value: input.statusLabel.trim() });

  if (input.tags.length > 0) {
    fields.push({ label: "Tags", value: input.tags.join(", ") });
  }

  if (input.parentTitle?.trim()) {
    fields.push({
      label: input.parentLevelLabel?.trim()
        ? `Parent ${input.parentLevelLabel.trim().toLowerCase()}`
        : "Parent",
      value: input.parentTitle.trim(),
    });
  }

  if (input.goals.length > 0) {
    fields.push({ label: "Goals it ladders up to", value: input.goals.join("; ") });
  }

  if (input.children.length > 0) {
    const shown = input.children.slice(0, CHILD_LIMIT);
    fields.push({
      label: "Child items",
      value: shown.map((c) => `${c.title} (${c.statusLabel})`).join("\n"),
      truncated: input.children.length > shown.length,
    });
  }

  const body = input.body.trim();
  if (body) {
    const { value, truncated } = truncate(body, BODY_CHAR_LIMIT);
    fields.push({ label: "Description", value, truncated });
  }

  return fields;
}

/**
 * Render the fields into the system turn.
 *
 * Truncation is announced in the prompt itself, not only in the UI. A model
 * given half a spec with no indication will answer confidently about a document
 * it has not seen the end of, and the person reading that answer has no way to
 * tell. Saying so costs a line and turns a wrong answer into a caveated one.
 */
function renderPrompt(
  fields: ContextField[],
  rules: string,
  task: string | null = null,
): string {
  const rendered = fields.map((f) => {
    const note = f.truncated ? " (shortened; you have not been shown all of it)" : "";
    // Multi-line values read better as a block than as "Label: line1 line2".
    return f.value.includes("\n")
      ? `${f.label}${note}:\n${f.value}`
      : `${f.label}${note}: ${f.value}`;
  });
  // The rules go above the item, not below it: instructions that follow a long
  // document are the ones a small model loses track of first, and the rule it
  // must not lose is the one saying nothing it produces is applied.
  //
  // A running skill sits between the rules and the item, in that order on
  // purpose: who you are, then what you may and may not do, then the job right
  // now, then the thing itself. A skill that came first would be read as
  // permission to do whatever it describes, which is exactly the rule that must
  // survive contact with a team's own wording.
  const head = task ? `${ROLE}\n\n${rules}\n\n${task}` : `${ROLE}\n\n${rules}`;
  return `${head}\n\n---\n\n${rendered.join("\n\n")}`;
}
