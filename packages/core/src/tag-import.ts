/**
 * Bulk tag import: turning a CSV into a set of registry operations.
 *
 * Two jobs arrive as one file. A one-column CSV is a list of tags to add, which
 * is the fast way to seed a taxonomy somebody already maintains in a
 * spreadsheet. A two-column CSV maps an existing tag to what it should be
 * called instead (`SF,Salesforce`), which is the rename that carries onto every
 * item that already had the old tag.
 *
 * The planning is pure and lives here rather than in the service so the preview
 * the user approves and the work the server does are computed by the same
 * function. The route re-plans against the live registry at apply time rather
 * than trusting the plan the client is holding, so a tag added by someone else
 * between preview and apply changes the outcome instead of corrupting it.
 *
 * Actions name tags by name, never by id. The applier resolves ids as it goes,
 * which is what lets one file rename `SF` to `Salesforce` on one line and merge
 * `sfdc` into that same `Salesforce` on the next, before the row exists.
 */

import { normalizeTagName, tagKey, tagNameError, type TagDef } from "./tags.js";

/** Most rows one upload may carry. A taxonomy larger than this is a script. */
export const TAG_IMPORT_MAX_ROWS = 1000;

/** Largest CSV accepted, in bytes. Generous for 1000 rows of short names. */
export const TAG_IMPORT_MAX_BYTES = 256 * 1024;

/** One planned operation, with the CSV line it came from. */
export type TagImportAction =
  | { kind: "create"; line: number; name: string }
  | { kind: "rename"; line: number; from: string; to: string }
  | { kind: "merge"; line: number; from: string; to: string }
  | { kind: "unchanged"; line: number; name: string; reason: string }
  | { kind: "error"; line: number; input: string; error: string };

/** Every action kind, for counting and for the preview's summary line. */
export type TagImportKind = TagImportAction["kind"];

/** The subset of actions that write. `unchanged` and `error` do nothing. */
export type TagImportWrite = Extract<
  TagImportAction,
  { kind: "create" | "rename" | "merge" }
>;

export interface TagImportPlan {
  actions: TagImportAction[];
  counts: Record<TagImportKind, number>;
  /** Whether anything here would write. A plan of no-ops needs no Apply. */
  writes: number;
}

/**
 * Split CSV text into rows of fields.
 *
 * A hand-rolled parser rather than a dependency because the grammar we accept
 * is tiny: comma-separated, optionally double-quoted, `""` for a literal quote.
 * Tag names cannot contain commas (see `tagNameError`), so an unquoted comma is
 * always a separator and the ambiguity that makes CSV hard does not arise.
 *
 * Blank lines are dropped rather than reported: a trailing newline is how every
 * editor ends a file, and Excel adds a few more.
 */
export function parseCsvRows(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let dirty = false;

  function endField() {
    cells.push(field);
    field = "";
  }
  function endRow() {
    endField();
    if (dirty || cells.some((c) => c.trim() !== "")) {
      out.push({ line: rowLine, cells });
    }
    cells = [];
    dirty = false;
    rowLine = line;
  }

  // Strip a UTF-8 BOM: Excel writes one and it would otherwise become part of
  // the first tag's name.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      // A quoted empty field is still a field the author wrote deliberately.
      dirty = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r") {
      // Swallowed; the \n that follows ends the row.
    } else if (ch === "\n") {
      line++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || cells.length > 0 || quoted) endRow();
  return out;
}

/**
 * Words that mark a first row as column headings rather than data, in a file
 * that has more than one column.
 *
 * Several of these (`new`, `old`, `to`, `from`) are words somebody could
 * plausibly use as a tag. That is tolerable across two columns, because
 * `new,old` as a pair of tag names is vanishingly rare next to `New,Old` as
 * headings, and intolerable in one column, which is why the single-column set
 * below is much smaller.
 */
const HEADER_WORDS = new Set([
  "tag",
  "tags",
  "name",
  "names",
  "tag name",
  "existing",
  "existing tag",
  "existing name",
  "current",
  "current tag",
  "current name",
  "old",
  "old tag",
  "old name",
  "from",
  "new",
  "new tag",
  "new name",
  "replacement",
  "rename to",
  "to",
]);

/**
 * Headings unambiguous enough to drop a row on their own.
 *
 * A one-column file is a list of tags, and `new` or `to` is a perfectly ordinary
 * tag to find at the top of one. Only words that describe the column rather than
 * name a thing are safe to discard without a second cell to corroborate them.
 */
const SOLO_HEADER_WORDS = new Set([
  "tag",
  "tags",
  "name",
  "names",
  "tag name",
  "tag names",
]);

/**
 * Whether the first row names columns instead of carrying data.
 *
 * Getting this wrong in the "it was data" direction loses a tag, which shows up
 * in the preview as a row that is simply not there; getting it wrong the other
 * way creates a tag called "Existing tag". Both are recoverable, and the preview
 * is what makes either survivable, but the split above keeps the common shapes
 * of both mistakes out of reach.
 */
export function looksLikeHeader(cells: readonly string[]): boolean {
  const values = cells.map((c) => c.trim().toLowerCase()).filter((c) => c !== "");
  if (values.length === 0) return false;
  const [solo] = values;
  if (values.length === 1) return SOLO_HEADER_WORDS.has(solo!);
  return values.every((v) => HEADER_WORDS.has(v));
}

/** The registry as the planner mutates it while walking the file. */
interface Projected {
  /** Canonical name by comparison key. */
  byKey: Map<string, string>;
  /** Ids of tags an earlier line already renamed or merged away. */
  touched: Set<string>;
  /** Comparison key -> registry id, for tags that exist in the database. */
  idByKey: Map<string, string>;
}

/**
 * Work out what a CSV would do to the registry.
 *
 * Rows are planned in order against a registry that accumulates each earlier
 * row's effect, so a file is read the way a person reads it: top to bottom,
 * where line 2 sees what line 1 did. That is what makes consolidating several
 * spellings onto one name in a single file behave, and it is why renaming a tag
 * twice in one file is refused rather than silently applying the last mapping.
 */
export function planTagImport(
  csv: string,
  registry: readonly TagDef[],
): TagImportPlan {
  const rows = parseCsvRows(csv);
  const actions: TagImportAction[] = [];

  const projected: Projected = {
    byKey: new Map(registry.map((t) => [tagKey(t.name), t.name])),
    touched: new Set(),
    idByKey: new Map(registry.map((t) => [tagKey(t.name), t.id])),
  };

  const [first] = rows;
  const body = first && looksLikeHeader(first.cells) ? rows.slice(1) : rows;

  for (const [index, row] of body.entries()) {
    if (index >= TAG_IMPORT_MAX_ROWS) {
      actions.push({
        kind: "error",
        line: row.line,
        input: row.cells.join(","),
        error: `Only the first ${TAG_IMPORT_MAX_ROWS} rows are read. Split the file and upload the rest separately.`,
      });
      break;
    }
    actions.push(planRow(row.line, row.cells, projected));
  }

  const counts: Record<TagImportKind, number> = {
    create: 0,
    rename: 0,
    merge: 0,
    unchanged: 0,
    error: 0,
  };
  for (const action of actions) counts[action.kind]++;

  return {
    actions,
    counts,
    writes: counts.create + counts.rename + counts.merge,
  };
}

function planRow(
  line: number,
  cells: readonly string[],
  projected: Projected,
): TagImportAction {
  const input = cells.join(",");
  const from = normalizeTagName(cells[0] ?? "");
  // Everything past the second column is ignored rather than rejected: a
  // spreadsheet exported with a notes column should still import.
  const to = normalizeTagName(cells[1] ?? "");

  // A single column, or a trailing comma with nothing after it, is "add this
  // tag" rather than a rename to nothing.
  if (to === "") return planCreate(line, input, from, projected);
  if (from === "") {
    return {
      kind: "error",
      line,
      input,
      error: `Missing the tag to rename. Put the existing tag first: "old,${to}".`,
    };
  }

  const problem = tagNameError(to);
  if (problem) return { kind: "error", line, input, error: problem };

  const fromKey = tagKey(from);
  const current = projected.byKey.get(fromKey);
  if (current === undefined) {
    return {
      kind: "error",
      line,
      input,
      error: `No tag named "${from}". Add it as a new tag, or correct the spelling.`,
    };
  }

  const sourceId = projected.idByKey.get(fromKey);
  if (sourceId !== undefined && projected.touched.has(sourceId)) {
    return {
      kind: "error",
      line,
      input,
      error: `"${current}" was already renamed earlier in this file. Map each tag once.`,
    };
  }

  const toKey = tagKey(to);
  if (toKey === fromKey) {
    // Same tag, so this is only ever a change of casing or spacing. Exactly
    // equal is a no-op; anything else is a rename the registry will accept
    // because its clash check excludes the tag being renamed.
    if (current === to) {
      return {
        kind: "unchanged",
        line,
        name: current,
        reason: "Already named this.",
      };
    }
    return applyRename(line, projected, fromKey, toKey, current, to, "rename");
  }

  if (projected.byKey.has(toKey)) {
    // The target already exists, so the two tags become one. The single-tag
    // rename refuses this on purpose (somebody fixing a typo is not asking for
    // a merge); here it is the whole point of uploading a mapping file, and the
    // preview labels the row so it is never a surprise.
    const target = projected.byKey.get(toKey)!;
    return applyRename(line, projected, fromKey, toKey, current, target, "merge");
  }

  return applyRename(line, projected, fromKey, toKey, current, to, "rename");
}

function planCreate(
  line: number,
  input: string,
  name: string,
  projected: Projected,
): TagImportAction {
  if (name === "") {
    return { kind: "error", line, input, error: "Tag name is required." };
  }
  const problem = tagNameError(name);
  if (problem) return { kind: "error", line, input, error: problem };

  const key = tagKey(name);
  const existing = projected.byKey.get(key);
  if (existing !== undefined) {
    return {
      kind: "unchanged",
      line,
      name: existing,
      reason:
        existing === name ? "Already exists." : `Already exists as "${existing}".`,
    };
  }
  projected.byKey.set(key, name);
  return { kind: "create", line, name };
}

/** Record a rename or merge in the projected registry and return its action. */
function applyRename(
  line: number,
  projected: Projected,
  fromKey: string,
  toKey: string,
  from: string,
  to: string,
  kind: "rename" | "merge",
): TagImportAction {
  const sourceId = projected.idByKey.get(fromKey);
  projected.byKey.delete(fromKey);
  projected.idByKey.delete(fromKey);
  if (kind === "rename") {
    projected.byKey.set(toKey, to);
    // The row keeps its id through a rename, so a later line asking to rename
    // it again is caught. A merge dissolves the source instead, and the
    // surviving tag keeps whatever id it already had.
    if (sourceId !== undefined) projected.idByKey.set(toKey, sourceId);
  }
  if (sourceId !== undefined) projected.touched.add(sourceId);
  return { kind, line, from, to };
}

/**
 * The example file the settings page offers as a starting point. Shows both
 * shapes: a row with a second column renames, a row without one adds.
 */
export const TAG_IMPORT_TEMPLATE = [
  "existing tag,new name",
  "SF,Salesforce",
  "area:web,",
  "area:api,",
].join("\n");
