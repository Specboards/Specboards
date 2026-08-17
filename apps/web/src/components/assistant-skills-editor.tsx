"use client";

import { useState } from "react";
import { toast } from "sonner";

import {
  BUILT_IN_SKILLS,
  MAX_SKILL_INSTRUCTION_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILLS,
  skillKeyFrom,
  skillRowsToStore,
  type Skill,
} from "@/lib/ai/skills";
import { saveAssistantSkills } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
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

  async function persist(next: Skill[], done: string) {
    setSaving(true);
    setError(null);
    try {
      // Only what differs from the built-ins is sent; see `skillRowsToStore`.
      const saved = await saveAssistantSkills(skillRowsToStore(next));
      setSkills(saved);
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
          { ...draft, builtIn: false, customised: false, enabled: true },
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

  const full = skills.length >= MAX_SKILLS;

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border">
        {skills.map((skill) =>
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
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{skill.name}</span>
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
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving || full}
          onClick={() => setEditing("")}
        >
          Add a skill
        </Button>
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

  const usable = name.trim() !== "" && instructions.trim() !== "";

  return (
    <div className="space-y-3">
      <FormField label="Name" hint="The button people press on an item.">
        <Input
          value={name}
          maxLength={MAX_SKILL_NAME_CHARS}
          onChange={(e) => setName(e.target.value)}
          placeholder="Grill me"
        />
      </FormField>
      <FormField
        label="Description"
        hint="One line, shown on hover. Not sent to the model."
      >
        <Input
          value={description}
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
