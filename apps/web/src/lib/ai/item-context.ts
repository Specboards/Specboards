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
  "",
  "You cannot change anything. You have no tools and no write access: nothing",
  "you say is applied to the item unless a person does it themselves. Do not",
  "claim to have made an edit.",
].join(" ");

/**
 * Assemble the context for one item.
 *
 * Absent and empty values are omitted rather than sent as "none": a field that
 * says "Parent: none" is noise in the prompt and, worse, a line in the
 * disclosure claiming we sent something we did not.
 */
export function assembleItemContext(input: ItemContextInput): AssembledContext {
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

  return { systemPrompt: renderPrompt(fields), fields };
}

/**
 * Render the fields into the system turn.
 *
 * Truncation is announced in the prompt itself, not only in the UI. A model
 * given half a spec with no indication will answer confidently about a document
 * it has not seen the end of, and the person reading that answer has no way to
 * tell. Saying so costs a line and turns a wrong answer into a caveated one.
 */
function renderPrompt(fields: ContextField[]): string {
  const rendered = fields.map((f) => {
    const note = f.truncated ? " (shortened; you have not been shown all of it)" : "";
    // Multi-line values read better as a block than as "Label: line1 line2".
    return f.value.includes("\n")
      ? `${f.label}${note}:\n${f.value}`
      : `${f.label}${note}: ${f.value}`;
  });
  return `${ROLE}\n\n---\n\n${rendered.join("\n\n")}`;
}
