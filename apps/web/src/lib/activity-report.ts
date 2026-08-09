import { statusLabel } from "@/lib/feature-helpers";
import { FIELD_LABELS } from "@/lib/item-history";
import type { ActivitySummary } from "@/lib/store/types";
import type { StatusWorkflow } from "@specboards/core";

/**
 * Turning the activity ledger's aggregates into something readable, and into
 * something honest.
 *
 * Two of these are load-bearing rather than cosmetic:
 *
 * `dailySeries` marks the days that fall before the ledger existed. A report
 * that draws those as zero says the team did nothing that week, when what
 * really happened is that nobody was writing it down. That is the one way this
 * page can actively mislead, so the distinction is in the data it renders from,
 * not left to a footnote.
 *
 * `formatDuration` and the stage-time rows keep `samples` attached. An average
 * over two spans is a rumour, and stage time is exactly the number people quote
 * in planning, so the sample count travels with the average everywhere it goes.
 */

/** The windows the page offers, shortest first. */
export const RANGES = [
  { key: "7", days: 7, label: "7 days" },
  { key: "30", days: 30, label: "30 days" },
  { key: "90", days: 90, label: "90 days" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export const DEFAULT_RANGE: RangeKey = "30";

/** Resolve the `?range=` param, falling back rather than erroring on junk. */
export function resolveRange(raw: string | string[] | undefined) {
  const key = Array.isArray(raw) ? raw[0] : raw;
  return RANGES.find((r) => r.key === key) ?? RANGES.find((r) => r.key === DEFAULT_RANGE)!;
}

/** UTC day key, matching how the ledger buckets `byDay`. */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The reporting window for a range, ending at the end of the day containing
 * `now`. `to` is exclusive, so today's changes are included.
 */
export function activityWindow(days: number, now: Date): { from: string; to: string } {
  const endDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const to = new Date(endDay + 24 * 60 * 60 * 1000);
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** One day in the window, as the chart draws it. */
export interface ActivityDay {
  day: string;
  count: number;
  /**
   * False for days that predate the ledger. Their zero means "not recorded",
   * which is a different claim from "nothing changed" and has to be drawn as
   * one.
   */
  recorded: boolean;
}

/**
 * Every day in the window, zero-filled, each one flagged with whether the
 * ledger was recording yet.
 *
 * The store only returns days that had activity, so without the fill a quiet
 * Tuesday and a Tuesday before the ledger existed both simply vanish, and the
 * chart silently closes the gap between them.
 */
export function dailySeries(
  summary: Pick<ActivitySummary, "byDay" | "since">,
  window: { from: string; to: string },
): ActivityDay[] {
  const counts = new Map(summary.byDay.map((d) => [d.day, d.count]));
  const sinceDay = summary.since ? dayKey(new Date(summary.since)) : null;

  const days: ActivityDay[] = [];
  const start = new Date(window.from);
  const end = new Date(window.to);
  for (let at = start; at < end; at = new Date(at.getTime() + 24 * 60 * 60 * 1000)) {
    const day = dayKey(at);
    days.push({
      day,
      count: counts.get(day) ?? 0,
      // No ledger at all means no day in the window was recorded, which is what
      // a workspace that has never been written to should say.
      recorded: sinceDay !== null && day >= sinceDay,
    });
  }
  return days;
}

/** How many days of the window predate the ledger, for the gap notice. */
export function unrecordedDays(days: ActivityDay[]): number {
  return days.filter((d) => !d.recorded).length;
}

/** A date for reading. UTC throughout, matching how the ledger buckets days. */
export function formatDay(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
}

/**
 * What the window's totals do and do not cover, in words.
 *
 * The sentences live here rather than in the view because they are the part
 * that has to be right: a window reaching back past the ledger's first day
 * contains blank days that say nothing about the team, and a reader who is not
 * told that reads a fall in output that never happened. `complete` is what the
 * view keys its emphasis off, so a qualified reading looks qualified before
 * anyone goes looking for the reason.
 */
export function coverageNote(
  since: string,
  missing: number,
  windowDays: number,
): { complete: boolean; headline: string; caveat: string } {
  const began = `Recording began on ${formatDay(since)}`;
  if (missing === 0) {
    return {
      complete: true,
      headline: `${began}, so this window is covered in full.`,
      caveat: "",
    };
  }
  const extent =
    missing === windowDays
      ? "This whole window predates the change ledger."
      : `The first ${missing} ${missing === 1 ? "day" : "days"} of this window predate it.`;
  return {
    complete: false,
    headline: `${began}. ${extent}`,
    caveat:
      "Those days show no activity because nothing was being recorded then, " +
      "not because nothing happened. Compare them with later days and the drop " +
      "is in the record, not in the work.",
  };
}

/**
 * A duration for reading, not for arithmetic.
 *
 * Stage time spans minutes to weeks depending on the stage, so a fixed unit
 * either rounds a fast stage to "0 hours" or reports a slow one as "412 hours"
 * and makes the reader do the division.
 */
export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "unknown";
  const plural = (n: number, unit: string) =>
    `${n} ${n === 1 ? unit : `${unit}s`}`;

  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return plural(minutes, "minute");
  }
  if (hours < 48) {
    const rounded = Math.round(hours * 10) / 10;
    return plural(rounded, "hour");
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return plural(days, "day");
}

/**
 * Below this many completed spans, an average is shown with a caveat. Chosen
 * to be obviously arbitrary but not silently so: the sample count is on screen
 * either way, and this only decides when to say out loud that it is thin.
 */
export const THIN_SAMPLE = 5;

/** Name a `byField` bucket: what kind of change this was. */
export function changeKindLabel(type: string, field: string | null): string {
  if (type === "spec.body_changed") return "Spec rewritten";
  if (type === "spec.moved") return "Spec moved";
  if (!field) return type;
  const label = FIELD_LABELS[field] ?? field;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Name a `stageTime` bucket: the stage an item was sitting in. */
export function stageLabel(status: string, workflow?: StatusWorkflow): string {
  return statusLabel(status, workflow);
}

/** Share of a total, as a width percentage; 0 when there is no total. */
export function share(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}
