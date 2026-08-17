"use client";

import { useMemo, useState } from "react";

import { diffHunks, diffLines, DIFF_CONTEXT, type DiffLine } from "@specboards/core";

import { Checkbox } from "@/components/ui/checkbox";

/**
 * What a proposed edit would do to a document, line by line.
 *
 * ── Why a diff and not the new text ─────────────────────────────────────────
 * A block of proposed Markdown looks complete and correct, and reading it tells
 * you almost nothing about what you are agreeing to. The thing a reviewer has
 * to see is what goes: a model asked to "add a failure section" that quietly
 * drops the non-goals is indistinguishable, in a block of new text, from one
 * that did exactly what it was asked. Removals are the whole reason this view
 * exists, which is why they are rendered at all rather than only counted.
 *
 * ── Why unchanged regions collapse ──────────────────────────────────────────
 * A proposal usually touches a small part of a long spec. Showing all of it
 * buries the three lines that changed among ninety that did not, and a reviewer
 * scrolling past ninety identical lines stops reading. The elided runs are
 * expandable rather than hidden, because "the rest is unchanged" is a claim the
 * reader is entitled to check.
 */

/**
 * How many unchanged lines to keep either side of a change.
 *
 * Taken from core rather than chosen here, because it decides where hunk
 * boundaries fall and so what a hunk *index* means. This view and the compose
 * that turns a selection of indices back into a document have to agree, or a
 * partial accept applies a different set of changes from the one that was
 * ticked, and nothing anywhere reports an error.
 */
const CONTEXT = DIFF_CONTEXT;

function LineRow({ line }: { line: DiffLine }) {
  const style =
    line.kind === "add"
      ? "bg-success/10 text-foreground"
      : line.kind === "remove"
        ? "bg-destructive/10 text-muted-foreground line-through decoration-destructive/40"
        : "text-muted-foreground";
  return (
    <div className={`flex gap-2 px-2 ${style}`}>
      {/* A glyph as well as a colour. Red and green alone is not a distinction
          for the eight percent of men who cannot make it, and this is the one
          view where mistaking a removal for an addition is expensive. */}
      <span aria-hidden className="select-none opacity-60">
        {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
      </span>
      <span className="whitespace-pre-wrap break-words">
        {line.text || " "}
      </span>
    </div>
  );
}

/**
 * One change, with the decision about whether to take it.
 *
 * A declined change is dimmed rather than removed from the view. What a
 * reviewer needs to see is the shape of the whole proposal and which parts of
 * it they are leaving behind: a change that vanishes when you untick it takes
 * with it the reason you were looking at it.
 *
 * The whole hunk is one control. Ticking a checkbox that sits beside a
 * *removal* and having it mean "yes, delete this" is the kind of double
 * negative nobody parses correctly under time pressure, so the label says what
 * the change does and the tick means "apply it".
 */
function ChoosableHunk({
  lines,
  taken,
  label,
  onToggle,
}: {
  lines: DiffLine[];
  taken: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <div className={taken ? undefined : "opacity-40"}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={taken}
        className="flex w-full items-center gap-2 border-y border-dashed bg-muted/30 px-2 py-1 text-left hover:bg-muted"
      >
        <Checkbox checked={taken} />
        <span className="text-muted-foreground">
          {label}
          {taken ? "" : " (not applying this)"}
        </span>
      </button>
      <div className="py-1">
        {lines.map((line, i) => (
          <LineRow key={i} line={line} />
        ))}
      </div>
    </div>
  );
}

/**
 * Render the change from `before` to `after`.
 *
 * Empty when the two are identical, which happens more than you would expect: a
 * model asked to tidy something already tidy proposes the document back
 * unchanged, and "here is a diff with nothing in it" is a confusing way to say
 * so.
 */
export function SpecDiff({
  before,
  after,
  selected,
  onToggleHunk,
}: {
  before: string;
  after: string;
  /**
   * Which changes are being taken, by hunk index. Omitted means the diff is
   * being read rather than decided on, and no per-change controls appear:
   * checkboxes beside a settled record invite a click that does nothing.
   */
  selected?: ReadonlySet<number>;
  onToggleHunk?: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const choosing = selected !== undefined && onToggleHunk !== undefined;

  const { lines, hunks, added, removed } = useMemo(() => {
    const lines = diffLines(before, after);
    const hunks = diffHunks(lines, CONTEXT);
    return {
      lines,
      hunks,
      added: lines.filter((l) => l.kind === "add").length,
      removed: lines.filter((l) => l.kind === "remove").length,
    };
  }, [before, after]);

  if (hunks.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This proposal matches the description as it already is, so accepting it
        would change nothing.
      </p>
    );
  }

  // The runs between hunks, plus the head and tail, are what gets elided.
  const gaps: { key: number; start: number; end: number }[] = [];
  let cursor = 0;
  for (const [i, hunk] of hunks.entries()) {
    if (hunk.start > cursor) gaps.push({ key: i, start: cursor, end: hunk.start });
    cursor = hunk.end;
  }
  if (cursor < lines.length) {
    gaps.push({ key: hunks.length, start: cursor, end: lines.length });
  }

  const blocks = [
    ...hunks.map((h, i) => ({ ...h, kind: "hunk" as const, key: `h${i}`, index: i })),
    ...gaps.map((g) => ({ ...g, kind: "gap" as const, key: `g${g.key}`, index: -1 })),
  ].sort((a, b) => a.start - b.start);

  /** "2 added, 1 removed", or the one-sided version. */
  const summary = (a: number, r: number) =>
    r === 0
      ? `${a} ${a === 1 ? "line" : "lines"} added`
      : a === 0
        ? `${r} ${r === 1 ? "line" : "lines"} removed`
        : `${a} added, ${r} removed`;

  return (
    <div className="space-y-2">
      <p className="text-2xs text-muted-foreground">
        {summary(added, removed)}
        {choosing && hunks.length > 1
          ? ` in ${hunks.length} changes. Untick any you do not want.`
          : ""}
      </p>
      <div className="overflow-x-auto rounded border bg-background font-mono text-2xs leading-relaxed">
        {blocks.map((block) =>
          block.kind === "hunk" ? (
            // Only offered when there is a choice to make. One change means
            // taking it or not, which is what Accept and Reject already are,
            // and a lone checkbox that duplicates them is a third control
            // saying the same thing.
            choosing && hunks.length > 1 ? (
              <ChoosableHunk
                key={block.key}
                lines={lines.slice(block.start, block.end)}
                taken={selected!.has(block.index)}
                label={summary(block.added, block.removed)}
                onToggle={() => onToggleHunk!(block.index)}
              />
            ) : (
              <div key={block.key} className="py-1">
                {lines.slice(block.start, block.end).map((line, i) => (
                  <LineRow key={`${block.key}-${i}`} line={line} />
                ))}
              </div>
            )
          ) : expanded.has(block.start) ? (
            <div key={block.key} className="py-1">
              {lines.slice(block.start, block.end).map((line, i) => (
                <LineRow key={`${block.key}-${i}`} line={line} />
              ))}
            </div>
          ) : (
            <button
              key={block.key}
              type="button"
              onClick={() =>
                setExpanded((prev) => new Set(prev).add(block.start))
              }
              className="w-full border-y border-dashed bg-muted/40 px-2 py-1 text-left text-muted-foreground hover:bg-muted"
            >
              {block.end - block.start} unchanged{" "}
              {block.end - block.start === 1 ? "line" : "lines"}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
