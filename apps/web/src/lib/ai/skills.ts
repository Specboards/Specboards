/**
 * Skills: the standing instructions a team gives their assistant.
 *
 * A skill is a saved way of asking, not a new subsystem. Running one adds a
 * block of instructions to the system turn and posts an ordinary turn to the
 * ordinary thread, so it inherits streaming, history, the disclosure, and
 * proposals-with-review for free. The alternative - a separate "interrogation
 * mode" with its own endpoint and its own transcript - would have to reimplement
 * all of that and would let the two drift.
 *
 * ── Why some skills live in code ────────────────────────────────────────────
 * Every workspace has the three below on the day it is created, including a
 * fresh self-host with an empty database, because they are constants rather than
 * seeded rows. Seeding would mean a backfill for existing workspaces, a seed
 * step for new ones, and a permanent question about what to do when we improve
 * one: rewriting rows a customer may have edited is not something a migration
 * should be deciding.
 *
 * A workspace overrides one by storing a row with the same {@link Skill.key}.
 * That row wins wholesale, and the built-in is left in the code as the thing
 * "Reset" goes back to. A row with an unrecognised key is simply a skill of the
 * team's own.
 *
 * ── Why this module is pure ─────────────────────────────────────────────────
 * Same reason as `item-context.ts`, which it feeds: the instructions here are
 * the largest single thing we send to a customer's model provider, and "here is
 * exactly what is sent" has to be a testable claim rather than a comment.
 */

/** A skill as it is defined, whether in code or in a row. */
export interface SkillDef {
  /**
   * Stable identifier. A row carrying a built-in's key overrides that built-in;
   * any other key is an addition. Keys are what make an override an override, so
   * they are never derived from the name after creation.
   */
  key: string;
  /** The button, and the user turn recorded when it is run. */
  name: string;
  /** One line under the button. Not sent to the model. */
  description: string;
  /** What the model is told while this skill is in force. */
  instructions: string;
}

/** A skill as the app resolves it: a definition plus where it came from. */
export interface Skill extends SkillDef {
  /** True when a built-in defines this key, whether or not a row overrides it. */
  builtIn: boolean;
  /** True when a row overrides a built-in, so the UI can offer Reset. */
  customised: boolean;
  /** False hides it from the panel without losing the wording. */
  enabled: boolean;
}

/** What a workspace has stored, before merging with the built-ins. */
export interface SkillRow extends SkillDef {
  enabled: boolean;
  position: number;
}

/** Longest skill name. Long enough to be a sentence fragment, short enough to
 * stay a button. */
export const MAX_SKILL_NAME_CHARS = 60;
/** Longest one-line description. */
export const MAX_SKILL_DESCRIPTION_CHARS = 200;
/**
 * Longest instruction body.
 *
 * Generous enough for a team to write out their real definition of ready, and
 * bounded because every one of these characters is prepended to a prompt that
 * also has to carry the item. A workspace running a small local model has a
 * budget measured in thousands of characters, and instructions that crowd out
 * the spec produce confident answers about nothing.
 */
export const MAX_SKILL_INSTRUCTION_CHARS = 4_000;
/** Most skills a workspace can define. A row of buttons stops being a row. */
export const MAX_SKILLS = 24;

/**
 * The skills every workspace starts with.
 *
 * These are opinions, and they are the product: the scarce thing is not writing
 * more words into a spec, it is being asked the question nobody asked. Written
 * to survive a small model, which means short sentences, no nested conditions,
 * and the most important rule last where it is least likely to be lost.
 */
export const BUILT_IN_SKILLS: readonly SkillDef[] = [
  {
    key: "grill",
    name: "Grill me",
    description:
      "Asks the awkward questions, one at a time, until the definition stops being vague.",
    instructions: [
      "Your task right now is to interrogate this definition, not to improve it yourself.",
      "",
      "Ask the person questions. Ask the single most important unanswered question first,",
      "and at most two more alongside it. A list of ten questions gets skimmed; one sharp",
      "question gets answered.",
      "",
      "The ground you are covering, roughly in this order:",
      "- What problem is this solving, and for whom specifically.",
      "- What happens when it fails, or when the input is not what was expected.",
      "- What is explicitly out of scope, and what someone might reasonably assume is in it.",
      "- How you would know afterwards whether it worked.",
      "- What this changes or breaks for people already using the product.",
      "- Who has to be told: support, docs, sales, anyone downstream.",
      "",
      "When an answer is vague, say so and ask again more precisely. \"We will figure that",
      "out later\" is not an answer; ask what would have to be true to decide it now.",
      "Do not thank the person for a vague answer and move on: that is the failure this",
      "skill exists to prevent.",
      "",
      "Do not propose a rewritten description while you are still finding gaps. When the",
      "answers have stopped being vague, say so and offer to draft it.",
    ].join("\n"),
  },
  {
    key: "gaps",
    name: "Find the gaps",
    description:
      "Lists what a competent engineer or agent would still have to guess.",
    instructions: [
      "Your task right now is a gap analysis of the description above, for the reader who",
      "has to build it: a competent engineer, or an agent working unattended.",
      "",
      "List what they would still have to guess. Put the most damaging one first. For each,",
      "name the decision that is missing and what goes wrong if it is guessed incorrectly.",
      "Be specific to this item: \"no acceptance criteria\" is a category, not a finding.",
      "",
      "Do not pad the list. Three real gaps are more useful than eight, and a generic gap",
      "teaches the reader to skim the next one. If the definition is genuinely good enough",
      "to build from, say that plainly and stop; that is a useful answer, not a failure.",
      "",
      "Do not rewrite the description as part of this. Point at what is missing.",
    ].join("\n"),
  },
  {
    key: "draft",
    name: "Draft a definition",
    description:
      "Writes the description out in full, following the shape this item already uses.",
    instructions: [
      "Your task right now is to write this item's description in full, and propose it as",
      "an edit.",
      "",
      "Follow the shape the description already uses: its headings, its order, its level of",
      "detail. If it has none yet, use the shape the parent or sibling items suggest. Do not",
      "impose a template of your own over a team's existing convention.",
      "",
      "Keep everything already decided. You are writing up what is known, not replacing it",
      "with something tidier. Where something is genuinely undecided, write a short line",
      "saying what is open rather than inventing an answer that reads as settled.",
      "",
      "Do not pad it to look thorough. A short description that is entirely true beats a",
      "long one a reader has to fact-check.",
    ].join("\n"),
  },
];

/**
 * The workspace's skills: the built-ins, overridden or extended by its rows.
 *
 * Built-ins come first and in code order, so the flagship skill is the first
 * button on every workspace and does not move when someone adds one of their
 * own. A team's own skills follow in their stored order.
 */
export function mergeSkills(rows: readonly SkillRow[]): Skill[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const builtIns = BUILT_IN_SKILLS.map((def) => {
    const row = byKey.get(def.key);
    return row
      ? { ...row, builtIn: true, customised: true }
      : { ...def, builtIn: true, customised: false, enabled: true };
  });

  const own = rows
    .filter((r) => !BUILT_IN_SKILLS.some((b) => b.key === r.key))
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ ...r, builtIn: false, customised: false }));

  return [...builtIns, ...own];
}

/**
 * The rows worth storing for a set of skills.
 *
 * An untouched built-in is deliberately NOT stored. If it were, a workspace that
 * opened this page and pressed Save would be pinned forever to whatever the
 * built-in said that day, and every later improvement to it would silently pass
 * them by. Storing only what a team actually changed means the ones they left
 * alone keep tracking the code.
 */
export function skillRowsToStore(skills: readonly Skill[]): SkillRow[] {
  const rows: SkillRow[] = [];
  for (const skill of skills) {
    const def = BUILT_IN_SKILLS.find((b) => b.key === skill.key);
    if (def && unchanged(def, skill)) continue;
    rows.push({
      key: skill.key,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      enabled: skill.enabled,
      position: rows.length,
    });
  }
  return rows;
}

function unchanged(def: SkillDef, skill: Skill): boolean {
  return (
    skill.enabled &&
    skill.name === def.name &&
    skill.description === def.description &&
    skill.instructions === def.instructions
  );
}

/**
 * A key for a newly added skill, unique against everything already in play.
 *
 * Derived from the name once, at creation, and never again: the key is what
 * makes an override an override and what a running thread refers to, so renaming
 * a skill must not orphan the conversations that used it.
 */
export function skillKeyFrom(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "skill";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** A skill is unusable without a name and something to instruct. */
export class SkillInputError extends Error {}

/**
 * Validate one skill as it arrives from a browser or an API client.
 *
 * Returns the cleaned definition rather than mutating in place, so the caller
 * cannot accidentally store the untrimmed original alongside the checked one.
 */
export function parseSkill(raw: unknown, taken: readonly string[]): SkillRow {
  if (!raw || typeof raw !== "object") {
    throw new SkillInputError("Each skill must be an object.");
  }
  const input = raw as Record<string, unknown>;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new SkillInputError("A skill needs a name.");
  if (name.length > MAX_SKILL_NAME_CHARS) {
    throw new SkillInputError(
      `A skill name can be at most ${MAX_SKILL_NAME_CHARS} characters.`,
    );
  }

  const instructions =
    typeof input.instructions === "string" ? input.instructions.trim() : "";
  if (!instructions) {
    throw new SkillInputError(
      `"${name}" has no instructions, so running it would do nothing.`,
    );
  }
  if (instructions.length > MAX_SKILL_INSTRUCTION_CHARS) {
    throw new SkillInputError(
      `"${name}" is longer than the ${MAX_SKILL_INSTRUCTION_CHARS.toLocaleString()} characters a skill can hold.`,
    );
  }

  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new SkillInputError(
      `The description of "${name}" can be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`,
    );
  }

  // A key sent by the client is honoured only if it is well formed; anything
  // else gets one derived from the name. Honouring it is what lets a workspace
  // override a built-in, and what keeps an edit an edit rather than a new skill
  // beside the old one.
  const sent = typeof input.key === "string" ? input.key.trim() : "";
  const key = /^[a-z0-9][a-z0-9-]{0,63}$/.test(sent)
    ? sent
    : skillKeyFrom(name, taken);

  return {
    key,
    name,
    description,
    instructions,
    enabled: input.enabled !== false,
    position: 0,
  };
}

/**
 * Validate a whole submitted set.
 *
 * Duplicate keys are rejected rather than de-duplicated: two rows claiming one
 * key means one of them is silently discarded, and the person who wrote it has
 * no way to tell which.
 */
export function parseSkills(raw: unknown): SkillRow[] {
  if (!Array.isArray(raw)) {
    throw new SkillInputError("skills must be an array.");
  }
  if (raw.length > MAX_SKILLS) {
    throw new SkillInputError(`A workspace can define at most ${MAX_SKILLS} skills.`);
  }
  const out: SkillRow[] = [];
  const keys: string[] = [];
  for (const entry of raw) {
    const skill = parseSkill(entry, keys);
    if (keys.includes(skill.key)) {
      throw new SkillInputError(`Two skills share the key "${skill.key}".`);
    }
    keys.push(skill.key);
    out.push({ ...skill, position: out.length });
  }
  return out;
}

/**
 * The block a running skill adds to the system turn.
 *
 * Rendered under its own heading rather than merged into the standing role, so
 * that a small model reading top to bottom meets "here is who you are", then
 * "here is what you may and may not do", then "here is the job right now", in
 * that order. Blurring the three is how a 3B model ends up grilling someone
 * about an item while claiming to have already edited it.
 */
export function skillTask(skill: SkillDef): string {
  return `Your current task: ${skill.name}\n\n${skill.instructions}`;
}
