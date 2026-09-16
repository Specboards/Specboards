"use client";

import { CalendarClock } from "lucide-react";
import { useEffect, useState, useTransition } from "react";

import {
  CadenceFields,
  cadencePayload,
  emptyCadence,
  type CadenceDraft,
} from "@/components/cadence-fields";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  createSchedule,
  deleteSchedule,
  listSchedulableSkills,
  listSchedules,
  type ScheduleView,
} from "@/lib/api-client/schedules";

/**
 * Setting a skill to run on this item, every week.
 *
 * ── Why creating happens here and not in settings ───────────────────────────
 * A schedule is "run this skill on that item". The place you know which item
 * you mean is the item, and a workspace-level form would need a picker over
 * every card, which is a worse version of the screen you just came from.
 * Settings owns the other half, the one only a workspace-wide list can answer:
 * what is running on its own, and is any of it broken.
 *
 * ── Why it fetches rather than arriving with the page ───────────────────────
 * The item page's data was assembled before schedules existed, and most items
 * will never have one. Adding a field to that loader for every card in the
 * workspace is a worse trade than one small request on the cards that open
 * this section.
 *
 * ── Add is an affordance, not an open form ──────────────────────────────────
 * The house rule, and it earns its place here: a blank cadence form sitting
 * under every item would be a standing claim that you were about to schedule
 * something, on hundreds of cards where nobody ever will.
 */

export function ItemSchedules({
  specId,
  canEdit,
}: {
  specId: string;
  canEdit: boolean;
}) {
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [skills, setSkills] = useState<{ key: string; name: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [skillKey, setSkillKey] = useState("");
  const [draft, setDraft] = useState<CadenceDraft>(emptyCadence);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    listSchedulableSkills()
      .then((list) => {
        if (!live) return;
        setSkills(list);
        // Selected here rather than in the initial state, because the list
        // arrives after the first render and a select with no value shows the
        // first option while reporting "" to the submit handler.
        setSkillKey((current) => current || (list[0]?.key ?? ""));
      })
      .catch(() => {});
    listSchedules()
      .then((all) => {
        // Filtered here rather than server-side: the list is small, and one
        // endpoint that always answers "all of them" is easier to reason about
        // than one whose result depends on a query parameter.
        if (live) setSchedules(all.filter((s) => s.targetSpecId === specId));
      })
      .catch(() => {
        if (live) setSchedules([]);
      });
    return () => {
      live = false;
    };
  }, [specId]);

  function reset() {
    setAdding(false);
    setName("");
    setSkillKey(skills[0]?.key ?? "");
    setDraft(emptyCadence());
    setError(null);
  }

  function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the schedule a name, so the list says what it is for.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const created = await createSchedule({
          name: trimmed,
          skillKey,
          specId,
          cadence: cadencePayload(draft),
          timeZone: draft.timeZone.trim(),
        });
        setSchedules((prev) => [...(prev ?? []), created]);
        reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      try {
        await deleteSchedule(id);
        setSchedules((prev) => (prev ?? []).filter((s) => s.id !== id));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete.");
      }
    });
  }

  if (schedules === null) {
    return <p className="text-sm text-muted-foreground">Loading schedules…</p>;
  }

  return (
    <div className="space-y-3">
      {schedules.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {schedules.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 p-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{s.name}</span>
                  {!s.enabled ? <Badge variant="secondary">Off</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {s.cadenceLabel}
                  {s.enabled ? (
                    <>
                      {" · next "}
                      <LocalTime iso={s.nextRunAt} />
                    </>
                  ) : null}
                </p>
                {s.lastError ? (
                  <p className="text-xs text-destructive">{s.lastError}</p>
                ) : null}
              </div>
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => remove(s.id)}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!canEdit ? null : adding ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Name</span>
              <Input
                value={name}
                placeholder="Weekly gap check"
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Skill to run</span>
              <Select
                value={skillKey}
                disabled={pending}
                onChange={(e) => setSkillKey(e.target.value)}
              >
                {skills.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <CadenceFields
            idPrefix={`new-schedule-${specId}`}
            value={draft}
            onChange={setDraft}
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">
            Each firing opens an agent run here. Anything it wants changed goes
            to the review queue, so a schedule never edits this item by itself.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || !skillKey} onClick={create}>
              Add schedule
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={skills.length === 0}
          onClick={() => setAdding(true)}
        >
          <CalendarClock aria-hidden className="size-4" />
          Run a skill on a schedule
        </Button>
      )}

      {skills.length === 0 && canEdit ? (
        <p className="text-xs text-muted-foreground">
          This workspace has no skills switched on, so there is nothing to
          schedule yet.
        </p>
      ) : null}
    </div>
  );
}
