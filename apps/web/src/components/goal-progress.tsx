import type { GoalRecord } from "@/lib/store/types";

/**
 * The two figures a goal reports, and the rule that they are never merged.
 *
 * Outcome is the mean of the goal's key results: did the metric move? Delivery
 * is the share of the linked work that is done: did we ship what we thought
 * would move it? A goal at 100% delivery and 0% outcome is the most useful
 * thing either the Goals page or the portfolio dashboard can show, and one
 * averaged bar would erase it. Shared so the two views cannot drift into
 * different arithmetic or different labels for the same number.
 */

/** One labelled progress figure. `null` reads as "not measured", not 0%. */
function ProgressReadout({
  label,
  hint,
  value,
  empty,
  compact = false,
}: {
  label: string;
  hint: string;
  value: number | null;
  empty: string;
  /** Drop the explanatory line, for a dense roll-up where it would repeat. */
  compact?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-sm font-medium">
          {value === null ? "—" : `${value}%`}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${label}: ${value === null ? empty : `${value} percent`}`}
      >
        {value !== null ? (
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${value}%` }}
          />
        ) : null}
      </div>
      {compact ? null : (
        <p className="text-2xs text-muted-foreground">
          {value === null ? empty : hint}
        </p>
      )}
    </div>
  );
}

/** Both of a goal's figures, side by side and labelled. */
export function GoalProgressPair({
  goal,
  compact = false,
}: {
  goal: Pick<
    GoalRecord,
    "progress" | "deliveryProgress" | "linkedItemCount"
  >;
  compact?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ProgressReadout
        label="Outcome"
        hint="Mean of this goal's key results: did the metric move?"
        value={goal.progress}
        empty="No key results yet"
        compact={compact}
      />
      <ProgressReadout
        label="Delivery"
        hint={`Share of the ${goal.linkedItemCount} linked item${
          goal.linkedItemCount === 1 ? "" : "s"
        } that are done: did the work ship?`}
        value={goal.deliveryProgress}
        empty="No work linked yet"
        compact={compact}
      />
    </div>
  );
}
