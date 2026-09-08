"use client";

import { useState, useTransition } from "react";

import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from "@/lib/notifications/catalog";
import type { MatrixRow, MatrixSource } from "@/lib/notifications/matrix";
import type { NotificationSettingChange } from "@/lib/store/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusLine, type SettingStatus } from "@/components/ui/setting-row";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The event-type-by-channel grid, shared by a user's own preferences and the
 * workspace defaults an admin sets.
 *
 * One component for both, per the release decision that the two features land
 * together: they are the same idea seen from either side, and building the
 * grid twice is how they would stop reading as one. What differs between them
 * is entirely in the props, and it comes down to one question: which layer
 * counts as "mine" here. A user owns the `user` layer and inherits the
 * workspace's; an admin owns the `workspace` layer and inherits the built-in
 * catalog. Everything else (the toggling, the reset affordances, the saving,
 * the email column's state) is identical, which is the point.
 *
 * ── On the Settings convention ──────────────────────────────────────────────
 * CLAUDE.md says a configured value in Settings is displayed rather than
 * opened, and this grid toggles in place, so it is worth saying why that is
 * not a violation. The convention is about inputs with something to type: "an
 * input on screen is a claim that the user has something to type", and a
 * pre-filled text field next to a Save button is a form asking to be
 * completed. A checkbox has nothing to complete. It is simultaneously the
 * display of the value and the control for it, so putting an Edit click in
 * front of it would produce two near-identical read-only and editable states
 * and buy nothing. There is no Save button either: a click is the save, which
 * is what keeps this a value being shown rather than a form being filled.
 */

interface NotificationMatrixProps {
  rows: MatrixRow[];
  /**
   * The layer this grid edits. A cell from this layer is the reader's own
   * choice; anything below it is inherited.
   */
  owns: Exclude<MatrixSource, "catalog">;
  /**
   * What a cell says when this grid's own layer decided it, and what it says
   * when a lower one did.
   *
   * Both are props because the same cell means different things on the two
   * screens. A workspace row an admin has set is not "your choice", it is this
   * workspace's, and reading it back to them in the first person would be
   * wrong on the one screen where the distinction between a personal setting
   * and a policy is the entire subject.
   */
  ownLabel: string;
  inheritedLabel: string;
  /** Wording for the reset affordances, e.g. "workspace default". */
  resetTargetLabel: string;
  /** How many people have overridden each cell. Admin grid only. */
  overrideCounts?: Record<string, Record<string, number>>;
  /**
   * Why the email column cannot be used right now, if it cannot.
   *
   * `note` sits under the column header, once, rather than beside every cell
   * in the column: repeating it per row put the same words next to eight
   * checkboxes and still left the column looking armed.
   *
   * `forcedOff` distinguishes the two blocks, which are not the same thing.
   * A deployment with no mail transport cannot act on these rows yet, but the
   * rows still mean what they say, so the column keeps showing its resolved
   * value. A reader who has unsubscribed will receive nothing whatever the
   * rows say, so the column has to show off: leaving ticks on it would be the
   * setting lying to them, which is the exact failure the master switch was
   * supposed to prevent.
   */
  emailBlocked?: { note: string; forcedOff?: boolean } | null;
  /** Persist a batch of cells and hand back the grid as it now resolves. */
  onSave(changes: NotificationSettingChange[]): Promise<MatrixRow[]>;
}

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: "In app",
  email: "Email",
};

export function NotificationMatrix({
  rows: initialRows,
  owns,
  ownLabel,
  inheritedLabel,
  resetTargetLabel,
  overrideCounts,
  emailBlocked,
  onSave,
}: NotificationMatrixProps) {
  const [rows, setRows] = useState(initialRows);
  const [status, setStatus] = useState<SettingStatus>(null);
  const [pending, startTransition] = useTransition();

  /**
   * Every write goes through here, and every write re-renders from the
   * server's answer rather than from what was clicked.
   *
   * That matters more than it looks. A cell can move without being touched:
   * an admin changing a default while somebody has this page open moves every
   * row that person has not overridden. Patching local state optimistically
   * would show them a grid that agrees with their click and disagrees with
   * their account, and the disagreement would be exactly on the rows the
   * feature exists to move.
   */
  function apply(changes: NotificationSettingChange[]) {
    if (changes.length === 0) return;
    setStatus(null);
    startTransition(async () => {
      try {
        setRows(await onSave(changes));
        setStatus({ kind: "ok", message: "Saved." });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not save.",
        });
      }
    });
  }

  /** Cells this reader has set, as reset instructions. */
  const mine = rows.flatMap((row) =>
    NOTIFICATION_CHANNELS.filter((c) => row.channels[c].source === owns).map(
      (channel) => ({ type: row.type, channel, enabled: null as null }),
    ),
  );

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            {/* Just "Notification". The labels underneath are written from
                the recipient's side ("an item is assigned to you"), so a
                header that added a person would shift it: this grid is read
                both by somebody setting their own and by an admin setting
                everybody's. */}
            <TableHead>Notification</TableHead>
            {NOTIFICATION_CHANNELS.map((channel) => (
              <TableHead key={channel} className="w-28 text-center">
                {CHANNEL_LABELS[channel]}
                {/* A channel that cannot deliver says so once, here, rather
                    than under every cell in its column. Repeating it per row
                    put the same words beside eight checkboxes and still left
                    the column looking armed. */}
                {channel === "email" && emailBlocked ? (
                  <span className="block text-[10px] font-normal leading-tight text-muted-foreground">
                    {emailBlocked.note}
                  </span>
                ) : null}
              </TableHead>
            ))}
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const overridden = NOTIFICATION_CHANNELS.filter(
              (c) => row.channels[c].source === owns,
            );
            return (
              <TableRow key={row.type}>
                <TableCell className="align-top">
                  <div className="font-medium">{row.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.description}
                  </div>
                </TableCell>
                {NOTIFICATION_CHANNELS.map((channel) => (
                  <TableCell key={channel} className="text-center align-top">
                    <MatrixCellControl
                      row={row}
                      channel={channel}
                      owns={owns}
                      ownLabel={ownLabel}
                      inheritedLabel={inheritedLabel}
                      count={overrideCounts?.[row.type]?.[channel]}
                      emailBlocked={emailBlocked}
                      disabled={pending}
                      onToggle={(enabled) =>
                        apply([{ type: row.type, channel, enabled }])
                      }
                    />
                  </TableCell>
                ))}
                <TableCell className="align-top">
                  {overridden.length > 0 ? (
                    <Button
                      variant="link"
                      size="inline"
                      className="text-xs"
                      disabled={pending}
                      onClick={() =>
                        apply(
                          overridden.map((channel) => ({
                            type: row.type,
                            channel,
                            enabled: null,
                          })),
                        )
                      }
                    >
                      Reset
                      <span className="sr-only">
                        {` ${row.label} to the ${resetTargetLabel}`}
                      </span>
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="flex items-center gap-3">
        {mine.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => apply(mine)}
          >
            {`Reset everything to the ${resetTargetLabel}`}
          </Button>
        ) : null}
        <StatusLine status={status} />
      </div>
    </div>
  );
}

/**
 * One cell: the checkbox, and a line saying where its value came from.
 *
 * The provenance line is always visible rather than shown only on the
 * overridden cells. Marking one state and not the other means the unmarked
 * state has to be inferred from the absence of a mark, which is a legend the
 * reader has to hold in their head, and it reads as "nothing to see here" on
 * exactly the rows somebody is scanning to work out where a setting came from.
 * Both states get a word.
 */
function MatrixCellControl({
  row,
  channel,
  owns,
  ownLabel,
  inheritedLabel,
  count,
  emailBlocked,
  disabled,
  onToggle,
}: {
  row: MatrixRow;
  channel: NotificationChannel;
  owns: Exclude<MatrixSource, "catalog">;
  ownLabel: string;
  inheritedLabel: string;
  count: number | undefined;
  emailBlocked: { note: string; forcedOff?: boolean } | null | undefined;
  disabled: boolean;
  onToggle(enabled: boolean): void;
}) {
  const cell = row.channels[channel];
  const isMine = cell.source === owns;
  // A blocked email column refuses the click: a live checkbox that produces no
  // mail is the failure the unsubscribe switch exists to prevent, reached from
  // the other side.
  const unavailable = channel === "email" && !!emailBlocked;
  const locked = disabled || unavailable;
  const checked =
    unavailable && emailBlocked?.forcedOff ? false : cell.enabled;

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`${row.label}, ${CHANNEL_LABELS[channel]}`}
        aria-describedby={
          unavailable ? undefined : `${row.type}-${channel}-source`
        }
        disabled={locked}
        onClick={() => onToggle(!cell.enabled)}
        className="rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Checkbox
          checked={checked}
          // A filled green check on a column that cannot deliver reads as
          // armed however the cell is labelled, so an unavailable one is drawn
          // in the muted palette: still showing its resolved value, visibly
          // not doing anything yet.
          className={
            unavailable && checked
              ? "border-muted-foreground/40 bg-muted text-muted-foreground"
              : undefined
          }
        />
      </button>
      {unavailable ? null : (
        <span
          id={`${row.type}-${channel}-source`}
          data-testid={`source-${channel}`}
          className={cn(
            "text-[10px] leading-tight",
            isMine ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {isMine ? ownLabel : inheritedLabel}
        </span>
      )}
      {count ? (
        <span className="text-[10px] leading-tight text-muted-foreground">
          {count === 1 ? "1 override" : `${count} overrides`}
        </span>
      ) : null}
    </div>
  );
}
