import { StatusDot } from "@/components/status-dot";
import { statusDotColor } from "@/lib/feature-helpers";
import type { GroupProductSummary } from "@/lib/store/types";

/**
 * The pieces a management roll-up is drawn from: a stacked status bar, its
 * legend, and a release progress line.
 *
 * Shared by the group dashboard and the leadership dashboard so the two cannot
 * drift: same colours, same workflow ordering, same idea of what "done" means.
 * Each renders from counts alone, so any caller that can aggregate items can use
 * them.
 */

/** Sum per-status counts across a set of product summaries. */
export function combineStatusCounts(
  summaries: GroupProductSummary[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of summaries) {
    for (const [status, n] of Object.entries(s.statusCounts)) {
      out[status] = (out[status] ?? 0) + n;
    }
  }
  return out;
}

/**
 * Workflow statuses first (in order), then any strays: a renamed or legacy key
 * still has items behind it, so it is shown rather than dropped.
 */
function orderStatuses(
  counts: Record<string, number>,
  statusOrder: string[],
): string[] {
  return [
    ...statusOrder.filter((s) => counts[s]),
    ...Object.keys(counts).filter((s) => !statusOrder.includes(s)),
  ];
}

/**
 * Horizontal stacked bar of item counts per status, in workflow order. Width
 * segments are percentage-based inline styles (allowed by the CSP's
 * `style-src-attr`, same as Radix's dynamic widths).
 *
 * Decorative: the legend beside it carries the same numbers as text.
 */
export function StatusBar({
  counts,
  statusOrder,
}: {
  counts: Record<string, number>;
  statusOrder: string[];
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <div className="h-2 w-full rounded-full bg-muted" aria-hidden />;
  }
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      aria-hidden
    >
      {orderStatuses(counts, statusOrder).map((status) => (
        <div
          key={status}
          style={{
            backgroundColor: statusDotColor(status),
            width: `${((counts[status] ?? 0) / total) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

/** Legend of status counts under a bar, workflow order. */
export function StatusLegend({
  counts,
  statusOrder,
  labels,
}: {
  counts: Record<string, number>;
  statusOrder: string[];
  labels: Record<string, string> | undefined;
}) {
  const ordered = orderStatuses(counts, statusOrder);
  if (ordered.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {ordered.map((status) => (
        <span
          key={status}
          className="flex items-center gap-1 text-xs text-muted-foreground"
        >
          <StatusDot status={status} />
          {labels?.[status] ?? status} {counts[status]}
        </span>
      ))}
    </div>
  );
}

/** Compact "n done of m" release progress line with a thin bar. */
export function ReleaseProgress({
  name,
  done,
  total,
}: {
  name: string;
  done: number;
  total: number;
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-32 truncate text-muted-foreground" title={name}>
        {name}
      </span>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        aria-hidden
      >
        <div
          className="h-full rounded-full bg-success"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-16 text-right tabular-nums text-muted-foreground">
        {done}/{total} done
      </span>
    </div>
  );
}
