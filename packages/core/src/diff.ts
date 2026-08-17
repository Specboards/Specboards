/**
 * Line diff, for showing someone what a proposed change would do.
 *
 * ── Why this is not the merge's diff ────────────────────────────────────────
 * `merge3` already computes a longest common subsequence, and it is tempting to
 * export its internals rather than write a second one. They answer different
 * questions. The merge asks "can these two edits both land", and its output is
 * a document. This asks "what would change if I said yes", and its output is
 * something a person reads. A shared implementation would have to serve both,
 * and the first time one needed a tuning change the other would inherit it
 * silently. The shared part, the LCS, is twenty lines.
 *
 * ── Why lines and not words ─────────────────────────────────────────────────
 * The documents here are Markdown specs, where a line is usually a sentence, a
 * bullet, or a heading: a unit a reader already thinks in. Word-level diffing
 * reads better on a one-word change and much worse on a rewritten paragraph,
 * which is the common case when an assistant drafts an edit. Line granularity
 * is also what makes {@link diffHunks} meaningful, and a hunk is the unit
 * someone accepts or leaves behind.
 */

/** One line's fate between two versions. */
export interface DiffLine {
  /** `same` survives, `remove` is only in the old, `add` only in the new. */
  kind: "same" | "add" | "remove";
  text: string;
}

/**
 * A contiguous run of changes, with the unchanged lines either side that make
 * it readable. Hunks are the unit a partial accept works in: taking half a
 * changed region is how you produce a document neither side wrote.
 */
export interface DiffHunk {
  /** Index into the diff line array where this hunk's rendering starts. */
  start: number;
  /** One past the last line of the hunk. */
  end: number;
  /** Lines added within this hunk. */
  added: number;
  /** Lines removed within this hunk. */
  removed: number;
}

/**
 * Unchanged lines kept either side of a change, for orientation.
 *
 * Shared rather than a per-call default, because it decides where hunk
 * boundaries fall and therefore what a hunk *index* means. A view that renders
 * with one value and a compose that reconstructs with another would agree about
 * how many hunks there are and disagree about which lines are in them, which
 * produces a document the person never saw and no error anywhere.
 */
export const DIFF_CONTEXT = 3;

/** Split into lines, treating the empty document as no lines rather than one. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * The diff from `before` to `after`, in reading order.
 *
 * Removals are emitted before the additions that replace them, which is the
 * convention every diff tool uses and the one a reader's eye expects: the old
 * line, then the new one under it.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // lengths[i][j] = LCS length of a[i..] and b[j..]. Suffix-indexed so the
  // walk below runs forward, which keeps the output in document order without
  // a reversal step.
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      out.push({ kind: "remove", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "remove", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/**
 * Group a diff into the regions worth showing, with `context` unchanged lines
 * around each.
 *
 * A proposal that rewrites one heading in a long spec is mostly unchanged text,
 * and rendering all of it buries the three lines that matter. Hunks are what
 * let the view show the change and offer the rest as "N unchanged lines".
 *
 * Adjacent hunks whose context would overlap are merged, so a paragraph with
 * two small edits reads as one region rather than two boxes with a single line
 * of "unchanged" wedged between them.
 */
export function diffHunks(lines: DiffLine[], context = DIFF_CONTEXT): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const [i, line] of lines.entries()) {
    if (line.kind === "same") continue;
    const start = Math.max(0, i - context);
    if (current && start <= current.end + context) {
      // Their context windows would touch or overlap, so splitting them would
      // produce two boxes with nothing between them: one region, not two.
      current.end = i + 1;
    } else {
      current = { start, end: i + 1, added: 0, removed: 0 };
      hunks.push(current);
    }
  }

  // Extend each hunk's trailing context, then count what it contains. Done as a
  // second pass because the trailing edge is only known once the hunk is
  // closed, and the counts must exclude context lines borrowed from a neighbour.
  for (const [h, hunk] of hunks.entries()) {
    const next = hunks[h + 1];
    hunk.end = Math.min(next ? next.start : lines.length, hunk.end + context);
    for (let i = hunk.start; i < hunk.end; i++) {
      if (lines[i]!.kind === "add") hunk.added++;
      else if (lines[i]!.kind === "remove") hunk.removed++;
    }
  }
  return hunks;
}

/**
 * The document you get by taking some of a proposal's changes and leaving the
 * rest, expressed as which hunks to include.
 *
 * ── Why hunks are the unit ──────────────────────────────────────────────────
 * Not individual lines. A change is usually a removal and the addition that
 * replaces it, and letting someone take the addition without the removal
 * produces a document that says the same thing twice, or the removal without
 * the addition and it says nothing at all. Neither is what they meant, and
 * neither is a state either side wrote. A hunk is the smallest run that stays
 * coherent when taken whole.
 *
 * ── How it reconstructs ─────────────────────────────────────────────────────
 * Every line of the diff has a side it belongs on. Unchanged lines survive
 * either way. An addition is in the result only if its hunk was taken; a
 * removal is in the result only if its hunk was *not*, because leaving a change
 * behind means keeping the line it would have deleted. That is the whole rule,
 * and it holds because {@link diffHunks} puts every changed line in exactly one
 * hunk.
 *
 * Selecting every hunk therefore reproduces `after` exactly, and selecting none
 * reproduces `before` exactly. Both are worth knowing: they are what make
 * "accept all" and "accept nothing" the same operation as accept and reject,
 * rather than a third code path that can drift from them.
 */
export function composeFromHunks(
  before: string,
  after: string,
  selected: ReadonlySet<number>,
  context = DIFF_CONTEXT,
): string {
  const lines = diffLines(before, after);
  const hunks = diffHunks(lines, context);

  // Changed-line index -> the hunk that owns it. Built once rather than
  // searched per line, and it is also what makes the invariant checkable: a
  // changed line with no owner would silently take the wrong side.
  const owner = new Map<number, number>();
  for (const [h, hunk] of hunks.entries()) {
    for (let i = hunk.start; i < hunk.end; i++) {
      if (lines[i]!.kind !== "same") owner.set(i, h);
    }
  }

  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.kind === "same") {
      out.push(line.text);
      continue;
    }
    const taken = selected.has(owner.get(i)!);
    if (line.kind === "add" ? taken : !taken) out.push(line.text);
  }
  return out.join("\n");
}
