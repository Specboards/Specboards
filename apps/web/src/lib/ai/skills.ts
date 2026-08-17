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

/**
 * What a workspace has stored, before merging with the built-ins.
 *
 * ── Why the text is nullable ────────────────────────────────────────────────
 * Null means "whatever the built-in says", and it is what lets a workspace put
 * the skills in its own order without freezing their wording. Ordering has to be
 * stored per skill, so dragging one built-in past another writes a row for both;
 * if that row had to carry the text as well, reordering would silently pin every
 * skill to the wording it had that afternoon, and no later improvement to those
 * prompts would ever reach that workspace again. Nobody would connect the two.
 *
 * So a row says two separable things: where this skill sits and whether it is
 * on (always), and what it says (only when a team has actually rewritten it).
 * Null is meaningless on a skill the team invented, and the parser refuses it
 * there rather than storing a row that resolves to nothing.
 */
export interface SkillRow {
  key: string;
  name: string | null;
  description: string | null;
  instructions: string | null;
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

/** The built-in with this key, if there is one. */
export function builtInSkill(key: string): SkillDef | undefined {
  return BUILT_IN_SKILLS.find((b) => b.key === key);
}

/**
 * The workspace's skills, in the order they should appear: the built-ins,
 * reordered, overridden or extended by the workspace's rows.
 *
 * A workspace that has stored nothing gets the built-ins in code order. Once it
 * has stored anything, its rows carry the order, because saving stores a row for
 * every skill on the page (see {@link skillRowsToStore}). A built-in with no row
 * therefore only happens when we have shipped a new one since that workspace
 * last saved, and it goes on the end: appearing last is a new button to notice,
 * whereas appearing in the middle silently shifts the ones people have learned
 * the position of.
 */
export function mergeSkills(rows: readonly SkillRow[]): Skill[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const resolved = BUILT_IN_SKILLS.map((def, i) => {
    const row = byKey.get(def.key);
    return {
      skill: {
        key: def.key,
        // Null is "whatever the built-in says", which is what a position-only
        // row stores. Resolved per field, so a team that renamed a skill but
        // left its instructions alone keeps tracking those instructions.
        name: row?.name ?? def.name,
        description: row?.description ?? def.description,
        instructions: row?.instructions ?? def.instructions,
        builtIn: true,
        customised: Boolean(
          row && (row.name !== null || row.description !== null || row.instructions !== null),
        ),
        enabled: row?.enabled ?? true,
      },
      // Unrowed built-ins sort after every stored one, keeping code order
      // among themselves.
      order: row ? row.position : Number.MAX_SAFE_INTEGER - BUILT_IN_SKILLS.length + i,
    };
  });

  const own = rows
    .filter((r) => !builtInSkill(r.key))
    .map((r) => ({
      skill: {
        key: r.key,
        // A team's own skill always carries its own text; the parser refuses to
        // store one that does not, so these fall back only to keep the types
        // honest rather than to describe a row that exists.
        name: r.name ?? "",
        description: r.description ?? "",
        instructions: r.instructions ?? "",
        builtIn: false,
        customised: false,
        enabled: r.enabled,
      },
      order: r.position,
    }));

  return [...resolved, ...own]
    .sort((a, b) => a.order - b.order)
    .map((e) => e.skill);
}

/**
 * The rows to store for a set of skills, in the order they are given.
 *
 * A row is written for every skill, because position and on/off are facts about
 * a workspace's arrangement that only a row can hold. What is NOT written is the
 * text of a built-in nobody has rewritten: those columns go in as null, so the
 * skill keeps resolving from the code and keeps tracking every later improvement
 * to that prompt. Reordering the buttons therefore costs a workspace nothing.
 *
 * The one thing this cannot express is "put a built-in back exactly where the
 * code has it", since after any save its position is stored. That is the right
 * trade: the order on screen is the order a person arranged, and a button that
 * moves on its own after a release would be worse than one that stays put.
 */
export function skillRowsToStore(skills: readonly Skill[]): SkillRow[] {
  return skills.map((skill, position) => {
    const def = builtInSkill(skill.key);
    return {
      key: skill.key,
      name: def && skill.name === def.name ? null : skill.name,
      description:
        def && skill.description === def.description ? null : skill.description,
      instructions:
        def && skill.instructions === def.instructions ? null : skill.instructions,
      enabled: skill.enabled,
      position,
    };
  });
}

/** The same skills, ordered by name. Case-insensitive so "grill" sorts with
 * "Grill" rather than after every capitalised name. */
export function skillsSortedByName(skills: readonly Skill[]): Skill[] {
  return skills
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * Move one skill up or down, returning a new list.
 *
 * A pure function because the off-by-one is the whole thing: a move that drops
 * the wrong neighbour looks almost right on a list of three and is wrong on a
 * list of ten. Out-of-range moves return the list unchanged rather than
 * throwing, so the caller does not have to guard the ends twice.
 */
export function moveSkill(
  skills: readonly Skill[],
  from: number,
  delta: number,
): Skill[] {
  const to = from + delta;
  if (from < 0 || from >= skills.length || to < 0 || to >= skills.length) {
    return skills.slice();
  }
  const next = skills.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
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

  // A key sent by the client is honoured only if it is well formed; anything
  // else gets one derived from the name. Honouring it is what lets a workspace
  // override a built-in, and what keeps an edit an edit rather than a new skill
  // beside the old one.
  const sent = typeof input.key === "string" ? input.key.trim() : "";
  const wellFormed = /^[a-z0-9][a-z0-9-]{0,63}$/.test(sent);
  const def = wellFormed ? builtInSkill(sent) : undefined;

  // Null is a legitimate value on a built-in's row: it stores that skill's
  // position and on/off state while leaving its wording to the code. On a skill
  // the team invented there is no code to fall back to, so the same row would
  // resolve to a nameless button that instructs nothing.
  const name = required(input.name, MAX_SKILL_NAME_CHARS, "name", def?.name);
  if (name === null && !def) throw new SkillInputError("A skill needs a name.");

  const label = name ?? def?.name ?? "A skill";
  const instructions = required(
    input.instructions,
    MAX_SKILL_INSTRUCTION_CHARS,
    "instructions",
    def?.instructions,
    label,
  );
  if (instructions === null && !def) {
    throw new SkillInputError(
      `"${label}" has no instructions, so running it would do nothing.`,
    );
  }

  // Unlike the two above, an empty description is a value rather than an
  // omission: clearing a built-in's one-liner is a thing a team may want, and
  // folding it back to null would resolve to ours again and look like the edit
  // did not save.
  const submitted =
    typeof input.description === "string" ? input.description.trim() : null;
  if (submitted !== null && submitted.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new SkillInputError(
      `The description of "${label}" can be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`,
    );
  }
  const description = submitted === def?.description ? null : submitted;

  return {
    key: wellFormed ? sent : skillKeyFrom(label, taken),
    name,
    description,
    instructions,
    enabled: input.enabled !== false,
    position: 0,
  };
}

/**
 * A field a skill cannot do without: trimmed, length-checked, and reduced to
 * null when it adds nothing over the built-in.
 *
 * Null means two different things depending on the key, which is why the caller
 * checks it rather than this: on a built-in it means "keep using ours", and on a
 * skill the team invented it means the submission is incomplete.
 *
 * Text identical to the built-in's is stored as null rather than as a copy. That
 * is what keeps "I only reordered them" from becoming "I now have my own fork of
 * all three prompts". The browser already does this in `skillRowsToStore`; doing
 * it here too means an API client gets the same treatment rather than quietly
 * opting its workspace out of every future improvement.
 */
function required(
  raw: unknown,
  limit: number,
  field: string,
  builtIn: string | undefined,
  label?: string,
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length > limit) {
    throw new SkillInputError(
      label
        ? `The ${field} of "${label}" can be at most ${limit.toLocaleString()} characters.`
        : `A skill ${field} can be at most ${limit.toLocaleString()} characters.`,
    );
  }
  if (!value || value === builtIn) return null;
  return value;
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
