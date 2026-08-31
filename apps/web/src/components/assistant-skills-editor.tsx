"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  BUILT_IN_SKILLS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INSTRUCTION_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILLS,
  moveSkill,
  skillKeyFrom,
  skillRowsToStore,
  skillsSortedByName,
  SKILL_SURFACES,
  SKILL_SURFACE_LABELS,
  type Skill,
  type SkillSurface,
} from "@/lib/ai/skills";
import { saveAssistantSkills } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * The skills a team's assistant can be asked to run.
 *
 * ── Why every action saves immediately ──────────────────────────────────────
 * There is no Save button for the page. Each edit, toggle, addition and removal
 * writes the whole set, which is the shape the endpoint takes anyway. The
 * alternative - accumulate changes locally, save at the end - means a person can
 * lose a carefully worded interrogation prompt by navigating away, and this is
 * exactly the kind of page someone edits in one tab while reading an item in
 * another.
 *
 * ── Why a built-in is edited rather than copied ─────────────────────────────
 * "Customise" opens the built-in's own wording and saves it under the same key,
 * so it keeps its place in the row and every thread already running it carries
 * on. Copy-to-new would leave two buttons called "Grill me" and no way to tell
 * which one a past conversation used.
 */
/**
 * How long a reorder waits before it is written.
 *
 * Long enough to absorb a run of clicks moving one skill several places, short
 * enough that nobody navigates away in the gap without noticing. The unmount
 * flush covers them if they do.
 */
const ORDER_SAVE_DELAY_MS = 700;

/**
 * Below this many skills, the A-to-Z control is not offered.
 *
 * Sorting three buttons is not organising anything, and a control that does
 * almost nothing still has to be read and dismissed by everyone who opens the
 * page. It appears once a team has enough of their own to have lost track.
 *
 * Derived from the built-in count rather than written as a number, because the
 * number was one: shipping the two release skills pushed the total to exactly
 * the old threshold, and the control appeared on a page where nobody had added
 * anything. What the rule means is "a couple more than we ship", so that is
 * what it now says.
 */
export const SORT_CONTROL_THRESHOLD = BUILT_IN_SKILLS.length + 2;

export function AssistantSkillsEditor({
  initial,
  canEdit,
}: {
  initial: Skill[];
  canEdit: boolean;
}) {
  const [skills, setSkills] = useState<Skill[]>(initial);
  /** The key being edited, or "" while adding a new one. Null when neither. */
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The order the person has arranged but that has not been written yet.
   *
   * Moving something is the one action here done in bursts: three clicks to
   * shift a skill three places. So the arrows rearrange the list at once and the
   * write is deferred, rather than each click going through a round trip that
   * disables the button it was aimed at.
   */
  const orderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The latest arrangement, for the deferred write to read at the time it
   * fires rather than the one captured when it was scheduled. */
  const latest = useRef<Skill[]>(initial);

  useEffect(() => {
    // A pending order that never gets written is worse than no reordering at
    // all, so leaving the page flushes it rather than dropping it.
    const timer = orderTimer;
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void saveAssistantSkills(skillRowsToStore(latest.current)).catch(() => {
          // Nothing left to tell: the component is gone. The order reverts on
          // the next load, which is the honest outcome of a failed write.
        });
      }
    };
  }, []);

  function remember(next: Skill[]) {
    latest.current = next;
    setSkills(next);
  }

  async function persist(next: Skill[], done: string) {
    // A pending reorder is folded into this write rather than racing it: two
    // whole-set replaces in flight at once means whichever lands second wins,
    // and that is as likely to be the older arrangement.
    if (orderTimer.current) {
      clearTimeout(orderTimer.current);
      orderTimer.current = null;
    }
    setSaving(true);
    setError(null);
    remember(next);
    try {
      // Only text that differs from the built-ins is sent; see `skillRowsToStore`.
      const saved = await saveAssistantSkills(skillRowsToStore(next));
      remember(saved);
      setEditing(null);
      toast.success(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  function onSaveOne(draft: SkillDraft) {
    const existing = skills.some((s) => s.key === draft.key);
    const next = existing
      ? skills.map((s) => (s.key === draft.key ? { ...s, ...draft } : s))
      : [
          ...skills,
          {
            ...draft,
            builtIn: false,
            customised: false,
            enabled: true,
          } satisfies Skill,
        ];
    void persist(next, existing ? "Skill saved." : `"${draft.name}" added.`);
  }

  function onToggle(skill: Skill) {
    void persist(
      skills.map((s) =>
        s.key === skill.key ? { ...s, enabled: !s.enabled } : s,
      ),
      skill.enabled ? `"${skill.name}" switched off.` : `"${skill.name}" switched on.`,
    );
  }

  /**
   * Put a customised built-in back to the wording we ship.
   *
   * Dropping the row is the whole mechanism: with nothing stored, the skill
   * resolves from code again, and it goes on tracking any later improvement to
   * that prompt rather than being frozen at whatever it said today.
   */
  function onReset(skill: Skill) {
    const def = BUILT_IN_SKILLS.find((b) => b.key === skill.key);
    if (!def) return;
    void persist(
      skills.map((s) =>
        s.key === skill.key
          ? { ...s, ...def, builtIn: true, customised: false, enabled: true }
          : s,
      ),
      `"${def.name}" is back to the version we ship.`,
    );
  }

  function onRemove(skill: Skill) {
    void persist(
      skills.filter((s) => s.key !== skill.key),
      `"${skill.name}" removed.`,
    );
  }

  /**
   * Move one skill up or down the row of buttons.
   *
   * Rearranges on screen at once and defers the write, so a burst of clicks is
   * one request and the arrows stay live throughout. The reorder itself costs a
   * workspace nothing: a built-in whose wording nobody has touched is stored
   * with null text, so it keeps tracking the code (see `skillRowsToStore`).
   */
  function onMove(key: string, delta: number) {
    // By key, and composed from the ref rather than from `skills`, because
    // moving something several places is several clicks and React has not
    // re-rendered between them. Reading the state list means the second click
    // recomputes the first click's move and the two collapse into one; keeping
    // the rendered index means the second click moves whichever skill has since
    // taken that slot. Both were real: the first is what clicking twice and
    // watching one move happen looked like.
    const from = latest.current.findIndex((s) => s.key === key);
    remember(moveSkill(latest.current, from, delta));
    if (orderTimer.current) clearTimeout(orderTimer.current);
    orderTimer.current = setTimeout(() => {
      orderTimer.current = null;
      void persist(latest.current, "Order saved.");
    }, ORDER_SAVE_DELAY_MS);
  }

  function onSortByName() {
    void persist(skillsSortedByName(skills), "Sorted A to Z.");
  }

  const full = skills.length >= MAX_SKILLS;

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border">
        {skills.map((skill, i) =>
          editing === skill.key ? (
            <li key={skill.key} className="p-3">
              <SkillForm
                initial={skill}
                busy={saving}
                onCancel={() => setEditing(null)}
                onSave={onSaveOne}
              />
            </li>
          ) : (
            <li
              key={skill.key}
              className="flex flex-wrap items-start justify-between gap-3 p-3"
            >
              {canEdit ? (
                <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    disabled={saving || i === 0}
                    onClick={() => onMove(skill.key, -1)}
                    aria-label={`Move ${skill.name} up`}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    disabled={saving || i === skills.length - 1}
                    onClick={() => onMove(skill.key, 1)}
                    aria-label={`Move ${skill.name} down`}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                </div>
              ) : null}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{skill.name}</span>
                  {/* Which assistant this button is on. Shown on every row
                      rather than only on release skills: a list where the
                      absence of a badge is what tells you something is an
                      item skill takes a moment to work out every time. */}
                  <Badge variant="secondary" size="sm">
                    {SKILL_SURFACE_LABELS[skill.surface]}
                  </Badge>
                  {skill.builtIn ? (
                    <Badge variant="outline" size="sm">
                      {skill.customised ? "Built in, edited" : "Built in"}
                    </Badge>
                  ) : null}
                  {!skill.enabled ? (
                    <Badge variant="secondary" size="sm">
                      Off
                    </Badge>
                  ) : null}
                </div>
                {skill.description ? (
                  <p className="text-xs text-muted-foreground">
                    {skill.description}
                  </p>
                ) : null}
              </div>
              {canEdit ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => setEditing(skill.key)}
                  >
                    {skill.builtIn && !skill.customised ? "Customise" : "Edit"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => onToggle(skill)}
                  >
                    {skill.enabled ? "Switch off" : "Switch on"}
                  </Button>
                  {skill.customised ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => onReset(skill)}
                    >
                      Reset
                    </Button>
                  ) : null}
                  {/* A built-in has no Remove: it would come straight back on
                      the next load, since it lives in the code. Switching it
                      off is the thing that actually means "not for us". */}
                  {!skill.builtIn ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => onRemove(skill)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ),
        )}
      </ul>

      {/* "Add" is an affordance until someone opts in, per the house rule: an
          empty three-field form sitting open reads as unfinished work. */}
      {canEdit && editing === "" ? (
        <div className="rounded-md border p-3">
          <SkillForm
            initial={{
              key: "",
              name: "",
              description: "",
              instructions: "",
              surface: "item",
            }}
            busy={saving}
            onCancel={() => setEditing(null)}
            onSave={(draft) =>
              onSaveOne({
                ...draft,
                key: skillKeyFrom(
                  draft.name,
                  skills.map((s) => s.key),
                ),
              })
            }
          />
        </div>
      ) : canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving || full}
            onClick={() => setEditing("")}
          >
            Add a skill
          </Button>
          {/* Only once there is enough to have lost track of; the arrows above
              are the ordinary way to arrange a handful. */}
          {skills.length >= SORT_CONTROL_THRESHOLD ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={onSortByName}
            >
              Sort A to Z
            </Button>
          ) : null}
        </div>
      ) : null}

      {full ? (
        <p className="text-xs text-muted-foreground">
          That is the most skills a workspace can define ({MAX_SKILLS}). Switch
          one off or remove it to add another.
        </p>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** The editable parts of a skill. The key is decided elsewhere, once. */
interface SkillDraft {
  key: string;
  name: string;
  description: string;
  instructions: string;
  /** Which assistant this button appears on. Fixed for a built-in: its surface
   * is a fact about what its instructions are for, not a preference. */
  surface: SkillSurface;
}

function SkillForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: SkillDraft;
  busy: boolean;
  onSave: (draft: SkillDraft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [surface, setSurface] = useState<SkillSurface>(initial.surface);

  const usable = name.trim() !== "" && instructions.trim() !== "";
  // A built-in's surface is resolved from code on the way in and on the way
  // out, so offering to change it here would be a control that does nothing.
  const builtIn = BUILT_IN_SKILLS.some((b) => b.key === initial.key);

  return (
    <div className="space-y-3">
      <FormField label="Name" hint="The button people press.">
        <Input
          value={name}
          maxLength={MAX_SKILL_NAME_CHARS}
          onChange={(e) => setName(e.target.value)}
          placeholder="Grill me"
        />
      </FormField>
      {builtIn ? null : (
        <FormField
          label="Where it appears"
          hint="Which assistant shows this button. A skill written for one reads as nonsense on the other."
        >
          <Select
            value={surface}
            onChange={(e) => setSurface(e.target.value as SkillSurface)}
          >
            {SKILL_SURFACES.map((s) => (
              <option key={s} value={s}>
                {SKILL_SURFACE_LABELS[s]}
              </option>
            ))}
          </Select>
        </FormField>
      )}
      <FormField
        label="Description"
        hint="One line, shown on hover. Not sent to the model."
      >
        <Input
          value={description}
          maxLength={MAX_SKILL_DESCRIPTION_CHARS}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Asks the awkward questions until the definition stops being vague."
        />
      </FormField>
      <FormField
        label="Instructions"
        hint="What the assistant is told while this skill is running. Write it as an instruction to the assistant, not as a question to the person."
      >
        <Textarea
          value={instructions}
          rows={10}
          maxLength={MAX_SKILL_INSTRUCTION_CHARS}
          onChange={(e) => setInstructions(e.target.value)}
          className="font-mono text-xs"
        />
      </FormField>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !usable}
          onClick={() =>
            onSave({
              key: initial.key,
              name: name.trim(),
              description: description.trim(),
              instructions: instructions.trim(),
              surface,
            })
          }
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {!usable ? (
          <p className="text-xs text-muted-foreground">
            A skill needs a name and instructions; without them there is nothing
            to run.
          </p>
        ) : null}
      </div>
    </div>
  );
}
