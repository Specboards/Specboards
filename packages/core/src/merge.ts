import { extractSections } from "./spec.js";

/**
 * Three-way merge for spec bodies.
 *
 * The case this exists for is the ordinary one: a product manager rewrites the
 * problem statement while a designer fills in the interaction notes. Their
 * edits do not overlap, and refusing the second save because the first landed
 * first turns "two people worked on the spec this afternoon" into an argument
 * about who has to redo their work. Concurrency control is supposed to stop
 * lost writes, not stop collaboration.
 *
 * The merge runs on lines rather than on headings, deliberately. Heading-based
 * merging looks tidier until someone renames a heading (which reads as one
 * section deleted and another added), edits the preamble above the first
 * heading, or reorders sections. Lines have none of those failure modes.
 * Headings are still used, but for *explaining* a conflict rather than
 * computing one: see {@link conflictingSections}.
 */

export interface Merge3Conflict {
  /** Lines as they were in the version both sides started from. */
  base: string[];
  /** Lines the caller wrote. */
  mine: string[];
  /** Lines the other write left behind. */
  theirs: string[];
}

export interface Merge3Result {
  /** The merged text. Only meaningful when `clean` is true. */
  merged: string;
  /** True when no region was edited by both sides. */
  clean: boolean;
  conflicts: Merge3Conflict[];
}

/**
 * Merge `mine` and `theirs`, both derived from `base`.
 *
 * A region only one side touched is taken from that side. A region both sides
 * changed to the same thing is taken once. A region both sides changed
 * differently is a conflict, and no attempt is made to guess: reporting it is
 * the honest answer, and the caller has a person to ask.
 */
export function merge3(base: string, mine: string, theirs: string): Merge3Result {
  const b = splitLines(base);
  const m = splitLines(mine);
  const t = splitLines(theirs);

  const mineMatches = matchedIndexes(b, m);
  const theirsMatches = matchedIndexes(b, t);

  const out: string[] = [];
  const conflicts: Merge3Conflict[] = [];
  let bi = 0;
  let mi = 0;
  let ti = 0;

  while (bi < b.length) {
    const mineStable = mineMatches.get(bi);
    const theirsStable = theirsMatches.get(bi);
    if (mineStable === mi && theirsStable === ti) {
      // This base line survived unchanged in both, and both sides are sitting
      // on it right now: a synchronization point, so emit and move all three.
      out.push(b[bi]!);
      bi++;
      mi++;
      ti++;
      continue;
    }

    // Walk forward to the next line that is stable in both and reachable in
    // both. Everything up to it is one region that at least one side changed.
    let nextB = bi + 1;
    while (nextB <= b.length) {
      if (nextB === b.length) break;
      const nm = mineMatches.get(nextB);
      const nt = theirsMatches.get(nextB);
      if (nm !== undefined && nt !== undefined && nm >= mi && nt >= ti) break;
      nextB++;
    }
    const endM = nextB === b.length ? m.length : mineMatches.get(nextB)!;
    const endT = nextB === b.length ? t.length : theirsMatches.get(nextB)!;

    const baseRegion = b.slice(bi, nextB);
    const mineRegion = m.slice(mi, endM);
    const theirsRegion = t.slice(ti, endT);
    emitRegion(out, conflicts, baseRegion, mineRegion, theirsRegion);

    bi = nextB;
    mi = endM;
    ti = endT;
  }

  // Anything appended past the end of the base by either side.
  if (mi < m.length || ti < t.length) {
    emitRegion(out, conflicts, [], m.slice(mi), t.slice(ti));
  }

  return { merged: out.join("\n"), clean: conflicts.length === 0, conflicts };
}

/** Decide one changed region and append its outcome. */
function emitRegion(
  out: string[],
  conflicts: Merge3Conflict[],
  base: string[],
  mine: string[],
  theirs: string[],
): void {
  const mineChanged = !sameLines(base, mine);
  const theirsChanged = !sameLines(base, theirs);

  if (!mineChanged) {
    out.push(...theirs);
    return;
  }
  if (!theirsChanged) {
    out.push(...mine);
    return;
  }
  if (sameLines(mine, theirs)) {
    // Both had the same idea. Emitting it once is the merge; emitting it twice
    // would be the bug this check exists to prevent.
    out.push(...mine);
    return;
  }
  conflicts.push({ base, mine, theirs });
  // Keep the caller's lines in `merged` so it stays readable if anything shows
  // it, but `clean` is false and no caller should be committing this.
  out.push(...mine);
}

/**
 * The headings both sides edited, which is what a conflict is called in the
 * language the people involved actually use. "You and Sam both changed
 * Acceptance Criteria" is a sentence a product manager can act on; a line
 * number in a merge is not.
 *
 * Computed from the section maps rather than from merge output, so it stays
 * true regardless of how the line merge chunked things. Text above the first
 * heading is reported as the empty string, which callers render as the spec's
 * opening rather than as a heading name.
 */
export function conflictingSections(
  base: string,
  mine: string,
  theirs: string,
): string[] {
  const changedByMine = changedSections(base, mine);
  const changedByTheirs = changedSections(base, theirs);
  return [...changedByMine].filter((heading) => changedByTheirs.has(heading));
}

/** Headings whose body (or presence) differs between two versions. */
function changedSections(base: string, next: string): Set<string> {
  const a = sectionMap(base);
  const b = sectionMap(next);
  const changed = new Set<string>();
  for (const heading of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(heading) !== b.get(heading)) changed.add(heading);
  }
  return changed;
}

/** Heading -> body, including a "" entry for the text above the first heading. */
function sectionMap(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  const sections = extractSections(markdown);
  const firstHeading = markdown.search(/^#{2,6}\s+/m);
  map.set("", (firstHeading === -1 ? markdown : markdown.slice(0, firstHeading)).trim());
  for (const section of sections) map.set(section.heading, section.body);
  return map;
}

/**
 * For every line of `from` that survives into `to`, where it ended up. Built
 * from the longest common subsequence, so it never claims a line moved past
 * another one: the merge above relies on the mapping being monotonic.
 */
function matchedIndexes(from: string[], to: string[]): Map<number, number> {
  const n = from.length;
  const m = to.length;
  // lengths[i][j] = LCS length of from[i..] and to[j..].
  const lengths: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        from[i] === to[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const matches = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (from[i] === to[j]) {
      matches.set(i, j);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

/** Split into lines, treating the empty document as no lines rather than one. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
