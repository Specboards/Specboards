"use client";

import { AlertTriangle, CalendarClock } from "lucide-react";
import { useState, useTransition } from "react";

import {
  CadenceFields,
  cadencePayload,
  type CadenceDraft,
} from "@/components/cadence-fields";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  deleteSchedule,
  updateSchedule,
  type ScheduleView,
} from "@/lib/api-client/schedules";

/**
 * Every recurring run in the workspace, in one list.
 *
 * ── Why this manages and does not create ────────────────────────────────────
 * A schedule is "run this skill on that item", and the place you know which
 * item you mean is the item. Creating one here would need a picker over every
 * card in the workspace, which is a worse version of a screen the person has
 * just come from. So creating lives on the item and this is where you see the
 * whole set, which is the question only a workspace-wide list can answer: what
 * is running on its own, and is any of it broken.
 *
 * ── Why failure is the loudest thing on the row ─────────────────────────────
 * A schedule that quietly stopped is the failure this feature was written to
 * avoid, and the owner already got a notification. This is where they come to
 * find out which one and why, so the error is on the row rather than behind a
 * disclosure, and a schedule switched off after repeated failures says so
 * instead of just looking disabled.
 *
 * ── Settings show a value, not an open form ─────────────────────────────────
 * The cadence renders as the sentence the server built, with Edit beside it.
 * Nobody opens this page to retype a schedule that is already right, and a
 * pre-filled form next to a Save button is a form asking to be completed when
 * there was nothing to complete.
 */

type Status = { kind: "ok" | "error"; message: string } | null;

function draftFrom(schedule: ScheduleView): CadenceDraft {
  const c = schedule.cadence;
  return {
    every: c.every,
    hour: c.hour,
    minute: c.minute,
    weekday: c.weekday ?? 1,
    day: c.day ?? 1,
    timeZone: schedule.timeZone,
  };
}

export function SchedulesCard({
  initialSchedules,
  canManage,
}: {
  initialSchedules: ScheduleView[];
  canManage: boolean;
}) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<CadenceDraft | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();

  function beginEdit(schedule: ScheduleView) {
    setEditing(schedule.id);
    setDraft(draftFrom(schedule));
    setName(schedule.name);
    setStatus(null);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(null);
    setStatus(null);
  }

  function save(id: string) {
    if (!draft) return;
    setStatus(null);
    startTransition(async () => {
      try {
        const updated = await updateSchedule(id, {
          name: name.trim(),
          cadence: cadencePayload(draft),
          timeZone: draft.timeZone.trim(),
        });
        setSchedules((prev) => prev.map((s) => (s.id === id ? updated : s)));
        cancelEdit();
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not save.",
        });
      }
    });
  }

  function toggle(schedule: ScheduleView) {
    setStatus(null);
    startTransition(async () => {
      try {
        const updated = await updateSchedule(schedule.id, {
          enabled: !schedule.enabled,
        });
        setSchedules((prev) =>
          prev.map((s) => (s.id === schedule.id ? updated : s)),
        );
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not update.",
        });
      }
    });
  }

  function remove(id: string) {
    setStatus(null);
    startTransition(async () => {
      try {
        await deleteSchedule(id);
        setSchedules((prev) => prev.filter((s) => s.id !== id));
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not delete.",
        });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedules</CardTitle>
        <CardDescription>
          Skills that run on their own, on a timer. Each firing opens an agent
          run on the item and leaves anything it wants changed in the review
          queue, so a schedule never edits the board by itself. Add one from the
          item you want it to run on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status ? (
          <p
            role="status"
            className={
              status.kind === "error"
                ? "text-sm text-destructive"
                : "text-sm text-success-fg"
            }
          >
            {status.message}
          </p>
        ) : null}

        {schedules.length === 0 ? (
          <EmptyState
            variant="inline"
            icon={<CalendarClock aria-hidden className="size-5" />}
            title="Nothing runs on a schedule yet"
            description="Open an item, choose a skill, and set it to run every week. Anything you set up appears here."
          />
        ) : (
          <ul className="divide-y rounded-md border">
            {schedules.map((schedule) => {
              const isEditing = editing === schedule.id;
              return (
                <li key={schedule.id} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{schedule.name}</span>
                        {!schedule.enabled ? (
                          <Badge variant="secondary">
                            {schedule.consecutiveFailures > 0
                              ? "Switched off after repeated failures"
                              : "Off"}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {schedule.cadenceLabel} · runs{" "}
                        <code className="font-mono">{schedule.skillKey}</code>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {schedule.enabled ? (
                          <>
                            Next <LocalTime iso={schedule.nextRunAt} />
                          </>
                        ) : (
                          "Not scheduled while it is off"
                        )}
                        {schedule.lastRunAt ? (
                          <>
                            {" · last ran "}
                            <LocalTime iso={schedule.lastRunAt} />
                          </>
                        ) : null}
                      </p>
                    </div>

                    {canManage && !isEditing ? (
                      <div className="flex shrink-0 gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => beginEdit(schedule)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => toggle(schedule)}
                        >
                          {schedule.enabled ? "Turn off" : "Turn on"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => remove(schedule.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  {schedule.lastError ? (
                    <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                      <span>
                        {schedule.lastError}
                        {schedule.consecutiveFailures > 1
                          ? ` (failed ${schedule.consecutiveFailures} times in a row)`
                          : null}
                      </span>
                    </p>
                  ) : null}

                  {isEditing && draft ? (
                    <div className="space-y-3 rounded-md border p-3">
                      <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">Name</span>
                        <Input
                          value={name}
                          disabled={pending}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </label>
                      <CadenceFields
                        idPrefix={`schedule-${schedule.id}`}
                        value={draft}
                        onChange={setDraft}
                        disabled={pending}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={pending}
                          onClick={() => save(schedule.id)}
                        >
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={cancelEdit}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {!canManage && schedules.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Only the workspace owner can change schedules.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
