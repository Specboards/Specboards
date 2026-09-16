"use client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

/**
 * The "how often" half of a schedule form, shared by the two places that set
 * one: the item card that creates a schedule, and the settings list that edits
 * an existing one.
 *
 * Shared as a component rather than copied, because the two would otherwise
 * drift into offering different cadences, and a schedule created on an item
 * that could not then be edited in settings would be a trap.
 *
 * ── Why the zone is prefilled from the browser ──────────────────────────────
 * "Every Monday at 09:00" means nothing without one, and asking somebody to
 * pick their own timezone from a list of six hundred is a question they can
 * already answer by looking at their clock. The browser knows; it is offered as
 * the default and stays editable, which matters for a team whose digest should
 * land in the office's morning rather than in whichever airport they are in.
 */

export interface CadenceDraft {
  every: "day" | "week" | "month";
  hour: number;
  minute: number;
  weekday: number;
  day: number;
  timeZone: string;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The viewer's own zone, or a safe default when the browser will not say. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function emptyCadence(): CadenceDraft {
  return {
    // Weekly at 09:00 on Monday: the shape of almost every schedule anybody
    // actually wants, so the form opens on the answer rather than on a blank.
    every: "week",
    hour: 9,
    minute: 0,
    weekday: 1,
    day: 1,
    timeZone: browserTimeZone(),
  };
}

/** The draft as the API takes it. `day` and `weekday` only where they mean something. */
export function cadencePayload(draft: CadenceDraft): Record<string, unknown> {
  const base = { every: draft.every, hour: draft.hour, minute: draft.minute };
  if (draft.every === "week") return { ...base, weekday: draft.weekday };
  if (draft.every === "month") return { ...base, day: draft.day };
  return base;
}

export function CadenceFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: CadenceDraft;
  onChange: (next: CadenceDraft) => void;
  disabled?: boolean;
  /** Ids have to be unique on a page that renders several of these at once. */
  idPrefix: string;
}) {
  const set = (patch: Partial<CadenceDraft>) => onChange({ ...value, ...patch });
  const clamp = (n: number, lo: number, hi: number) =>
    Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : lo;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">How often</span>
        <Select
          id={`${idPrefix}-every`}
          value={value.every}
          disabled={disabled}
          onChange={(e) =>
            set({ every: e.target.value as CadenceDraft["every"] })
          }
        >
          <option value="day">Every day</option>
          <option value="week">Every week</option>
          <option value="month">Every month</option>
        </Select>
      </label>

      {value.every === "week" ? (
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">On</span>
          <Select
            id={`${idPrefix}-weekday`}
            value={String(value.weekday)}
            disabled={disabled}
            onChange={(e) => set({ weekday: Number(e.target.value) })}
          >
            {WEEKDAYS.map((name, i) => (
              <option key={name} value={String(i)}>
                {name}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

      {value.every === "month" ? (
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Day of the month</span>
          <Input
            id={`${idPrefix}-day`}
            type="number"
            min={1}
            max={31}
            value={value.day}
            disabled={disabled}
            onChange={(e) => set({ day: clamp(Number(e.target.value), 1, 31) })}
          />
          {value.day > 28 ? (
            // Said here rather than discovered in February. Clamping is what the
            // server does; saying so up front is what stops it looking like a bug.
            <span className="block text-muted-foreground">
              Months without a {value.day}th fire on their last day.
            </span>
          ) : null}
        </label>
      ) : null}

      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">At</span>
        <div className="flex items-center gap-1">
          <Input
            id={`${idPrefix}-hour`}
            type="number"
            min={0}
            max={23}
            aria-label="Hour"
            value={value.hour}
            disabled={disabled}
            onChange={(e) => set({ hour: clamp(Number(e.target.value), 0, 23) })}
          />
          <span aria-hidden className="text-muted-foreground">
            :
          </span>
          <Input
            id={`${idPrefix}-minute`}
            type="number"
            min={0}
            max={59}
            aria-label="Minute"
            value={value.minute}
            disabled={disabled}
            onChange={(e) =>
              set({ minute: clamp(Number(e.target.value), 0, 59) })
            }
          />
        </div>
      </label>

      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">Time zone</span>
        <Input
          id={`${idPrefix}-zone`}
          value={value.timeZone}
          disabled={disabled}
          onChange={(e) => set({ timeZone: e.target.value })}
        />
        <span className="block text-muted-foreground">
          The clock this follows, so it stays put when the clocks change.
        </span>
      </label>
    </div>
  );
}
