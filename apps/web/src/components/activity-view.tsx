import Link from "next/link";

import {
  RANGES,
  THIN_SAMPLE,
  changeKindLabel,
  coverageNote,
  dailySeries,
  formatDay,
  formatDuration,
  share,
  stageLabel,
  unrecordedDays,
  type ActivityDay,
} from "@/lib/activity-report";
import { InfoTip } from "@/components/ui/tooltip";
import { describeActor } from "@/lib/item-history";
import type { ActivitySummary } from "@/lib/store/types";
import type { StatusWorkflow } from "@specboards/core";

/**
 * Activity: what changed in a window, who changed it, and how long items sat in
 * each stage.
 *
 * This page is read to answer "how are we doing", which is exactly the question
 * a chart can answer wrongly and confidently. Two things it therefore never
 * does: draw days before the ledger existed as days of zero output, and print a
 * stage average without the number of spans behind it.
 */

export function ActivityView({
  summary,
  window,
  rangeKey,
  scopeLabel,
  basePath,
  workflow,
}: {
  summary: ActivitySummary;
  window: { from: string; to: string };
  rangeKey: string;
  /** What this report covers: a product name, a group name, or all products. */
  scopeLabel: string;
  /** The activity route for the current scope, for the range links. */
  basePath: string;
  workflow?: StatusWorkflow;
}) {
  const days = dailySeries(summary, window);
  const missing = unrecordedDays(days);
  // `to` is exclusive, so the last day in the window is the one to name.
  const lastDay = days[days.length - 1]?.day ?? window.from;

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
          <RangePicker basePath={basePath} rangeKey={rangeKey} />
        </div>
        <p className="text-sm text-muted-foreground">
          {scopeLabel} · {formatDay(window.from)} to {formatDay(lastDay)}
        </p>
      </div>

      {summary.since === null ? (
        <NothingRecordedYet />
      ) : (
        <>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {summary.total}
              </span>
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                {summary.total === 1 ? "change" : "changes"} recorded in this window
                <RecordingCoverage
                  since={summary.since}
                  missing={missing}
                  windowDays={days.length}
                />
              </span>
            </div>
            <DailyChart days={days} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Breakdown
              title="Who changed things"
              empty="No changes to attribute yet."
              rows={summary.byActor.map((a) => ({
                key: `${a.actorType}:${a.actorId ?? a.actorLabel ?? ""}`,
                label: describeActor(a).actor,
                muted: describeActor(a).automated,
                count: a.count,
              }))}
              total={summary.total}
            />
            <Breakdown
              title="What changed"
              empty="No changes to break down yet."
              rows={summary.byField.map((f) => ({
                key: `${f.type}:${f.field ?? ""}`,
                label: changeKindLabel(f.type, f.field),
                muted: false,
                count: f.count,
              }))}
              total={summary.total}
            />
          </div>

          <StageTime rows={summary.stageTime} workflow={workflow} />
        </>
      )}
    </section>
  );
}

function RangePicker({ basePath, rangeKey }: { basePath: string; rangeKey: string }) {
  return (
    <div className="flex items-center gap-1 text-xs">
      {RANGES.map((r) => (
        <Link
          key={r.key}
          href={`${basePath}?range=${r.key}`}
          aria-current={r.key === rangeKey ? "page" : undefined}
          className={
            r.key === rangeKey
              ? "rounded-md bg-muted px-2 py-1 font-medium"
              : "rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted/50"
          }
        >
          {r.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * The empty state, before the ledger holds anything at all. Stays a block
 * rather than a tooltip: it is the only thing on the page, so there is no
 * number for it to qualify and nothing else for the reader to look at.
 */
function NothingRecordedYet() {
  return (
    <div className="rounded-md border border-dashed p-4 text-sm">
      <p className="font-medium">No changes recorded yet</p>
      <p className="mt-1 text-muted-foreground">
        Specboards began keeping a change ledger when this workspace was
        upgraded. Changes made from now on appear here; anything before that was
        not recorded.
      </p>
    </div>
  );
}

/**
 * Where the history begins, attached to the count it qualifies.
 *
 * The ledger started when it was deployed, so a window reaching back past that
 * point contains days that are blank for a reason that has nothing to do with
 * the team. Left unsaid, that reads as a fall in output, and the reader draws a
 * conclusion about people from an artefact of the schema. It sits on the total
 * rather than above the page because that is the number it changes the meaning
 * of, and a banner over every report is read once and then never again.
 *
 * A partly-covered window gets the warning tone, so the caveat is visible
 * before anyone hovers; a fully covered one is ordinary reassurance and stays
 * quiet.
 */
function RecordingCoverage({
  since,
  missing,
  windowDays,
}: {
  since: string;
  missing: number;
  windowDays: number;
}) {
  const note = coverageNote(since, missing, windowDays);
  return (
    <InfoTip
      label="What this window covers"
      tone={note.complete ? "muted" : "warning"}
    >
      <p className="font-medium">{note.headline}</p>
      {note.caveat ? (
        <p className="mt-1.5 text-muted-foreground">{note.caveat}</p>
      ) : null}
    </InfoTip>
  );
}

/**
 * Changes per day. Decorative: the total above it and the breakdowns below
 * carry the same information as text, and each column names itself on hover.
 */
function DailyChart({ days }: { days: ActivityDay[] }) {
  const peak = Math.max(1, ...days.map((d) => d.count));
  return (
    <div className="space-y-2">
      <div className="flex h-24 items-end gap-px" aria-hidden>
        {days.map((d) => (
          <div
            key={d.day}
            className="flex h-full flex-1 flex-col justify-end"
            title={
              d.recorded
                ? `${formatDay(d.day)}: ${d.count} ${d.count === 1 ? "change" : "changes"}`
                : `${formatDay(d.day)}: not recorded`
            }
          >
            {d.recorded ? (
              <div
                className="w-full rounded-t-sm bg-primary"
                // A day with one change still has to be visible, or the chart
                // says nothing happened on a day that something did.
                style={{ height: `${d.count === 0 ? 0 : Math.max(4, (d.count / peak) * 100)}%` }}
              />
            ) : (
              <div className="h-full w-full rounded-sm bg-muted/60" />
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-primary" aria-hidden />
          Changes per day
        </span>
        {days.some((d) => !d.recorded) ? (
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm border border-border bg-muted/60" aria-hidden />
            Not recorded
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A ranked breakdown with share bars: same shape for actors and for fields. */
function Breakdown({
  title,
  rows,
  total,
  empty,
}: {
  title: string;
  rows: { key: string; label: string; muted: boolean; count: number }[];
  total: number;
  empty: string;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-2 text-xs">
              <span
                className={`w-40 truncate ${r.muted ? "text-muted-foreground" : ""}`}
                title={r.label}
              >
                {r.label}
              </span>
              <div
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                aria-hidden
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${share(r.count, total)}%` }}
                />
              </div>
              <span className="w-10 text-right tabular-nums text-muted-foreground">
                {r.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Average time in each stage, never without its sample count.
 *
 * This is the number that ends up in a planning conversation ("we spend four
 * days in review"), so the count it was drawn from is a column of the table
 * rather than a tooltip, and a thin one says so in words.
 */
function StageTime({
  rows,
  workflow,
}: {
  rows: ActivitySummary["stageTime"];
  workflow?: StatusWorkflow;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <h2 className="text-sm font-semibold tracking-tight">Time in each stage</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No completed stage times yet. A stage is only measured when both the
          move into it and the move out of it were recorded, so the first spans
          appear once items have moved twice.
        </p>
      ) : (
        <>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="pb-1 font-normal">Stage</th>
                <th className="pb-1 text-right font-normal">Average time</th>
                <th className="pb-1 text-right font-normal">Based on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.status} className="border-t">
                  <td className="py-1.5">{stageLabel(r.status, workflow)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatDuration(r.averageHours)}
                    {r.samples < THIN_SAMPLE ? (
                      <span className="ml-1 text-muted-foreground">(indicative)</span>
                    ) : null}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                    {r.samples} {r.samples === 1 ? "span" : "spans"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-2xs text-muted-foreground">
            An item&rsquo;s current stage is still running and is not counted, and
            neither is the stage it was in before recording began. Averages drawn
            from fewer than {THIN_SAMPLE} spans are marked indicative.
          </p>
        </>
      )}
    </div>
  );
}
