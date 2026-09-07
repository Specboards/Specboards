import {
  childLevelKey,
  findLevel,
  isValidParentLevel,
  parentLevelKey,
  propertyAppliesToLevel,
  resolveLevels,
  type PropertyDef,
  type WorkspaceLevel,
} from "@specboards/core";

import {
  BUILTIN_METADATA_FIELDS,
  CUSTOM_FIELD_PREFIX,
  isFieldAvailable,
} from "@/lib/card-fields";
import { gateFieldCatalog } from "@/lib/gate-fields";
import { gateDisplayLabel, gateSatisfied } from "@/lib/gate-fields";
import type { FeatureRecord, StageGate } from "@/lib/store/types";

/**
 * What converting an item to another level would do, and what stops it.
 *
 * An item's level was decided at creation and could never change, so a Feature
 * that turned out to be an Epic had to be recreated by hand: new card, body
 * copied across, children re-pointed, re-scheduled, and the original's id,
 * comments and history left behind. Working out that a Feature is really an
 * Epic is the normal outcome of breaking work down, not an edge case.
 *
 * ── The preview is the feature; the write is the easy part ───────────────────
 * A level is not an isolated column. It decides which parent is legal, which
 * children are legal, whether a spec may be attached, which custom properties
 * and built-in fields are shown, and which stage gates the item can still
 * satisfy. This module answers all of that in one pass so the same answer can
 * be shown to the user before they commit and enforced when they do. Two code
 * paths that agreed today would disagree the first time either changed.
 *
 * ── Refuse rather than repair ───────────────────────────────────────────────
 * Where a conversion would leave the hierarchy invalid, this returns a blocker
 * that names the items in the way, and the conversion does not happen. It does
 * not insert intermediate cards or move children to make it work. An automatic
 * repair that guesses wrong is far more expensive to undo than a refusal is to
 * work around, and every repair worth having later is easier to design once we
 * can see which refusals people actually hit.
 *
 * The parent is the one exception, and only because the alternative is worse:
 * almost every conversion invalidates the current parent, so refusing on that
 * alone would refuse nearly everything. Detaching is offered as part of the
 * same confirmed operation, and it is stated plainly in the preview rather
 * than done quietly.
 */

/** Enough of an item to plan a conversion of it. */
export interface ConversionSubject {
  specId: string;
  title: string;
  level: string;
  status: string;
  /** Path of the attached spec file, or null for a DB-native card. */
  specPath: string | null;
  parentSpecId: string | null;
}

/** An item named in a blocker, so the UI can link the fix. */
export interface ConversionItemRef {
  specId: string;
  title: string;
  level: string;
}

export type ConversionBlocker =
  | { kind: "unknown-level"; message: string }
  | { kind: "same-level"; message: string }
  | { kind: "spec-attached"; message: string }
  | { kind: "children-stranded"; message: string; items: ConversionItemRef[] }
  | { kind: "gates-unsatisfiable"; message: string; gates: string[] };

/** Something the conversion will do, stated before it is confirmed. */
export interface ConversionEffect {
  kind:
    | "parent-detached"
    | "parent-kept"
    | "children-kept"
    | "fields-lost"
    | "fields-gained"
    | "properties-hidden"
    | "properties-shown"
    | "template-mismatch";
  message: string;
}

export interface ConversionPlan {
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  /** Empty means the conversion may proceed. */
  blockers: ConversionBlocker[];
  effects: ConversionEffect[];
  /** True when confirming will also clear the item's parent. */
  detachesParent: boolean;
}

export interface ConversionInput {
  item: ConversionSubject;
  /** The target level key. */
  to: string;
  /** The item as a gate subject: field gates read its own values. */
  record: FeatureRecord;
  parent: ConversionItemRef | null;
  children: ConversionItemRef[];
  levels: readonly WorkspaceLevel[] | null;
  /** Item properties defined for the item's product. */
  properties: readonly PropertyDef[];
  /** Gates for the item's product, every stage. */
  gates: readonly StageGate[];
  /** Checklist gate ids already completed for this item. */
  completedGateIds: readonly string[];
  /** The product's workflow stages, in order. */
  statuses: readonly string[];
  /** Stage labels for readable gate messages, keyed by stage key. */
  statusLabels: Readonly<Record<string, string>>;
}

export function planConversion(input: ConversionInput): ConversionPlan {
  const levels = resolveLevels(input.levels);
  const from = input.item.level;
  const to = input.to;
  const fromLevel = findLevel(from, levels);
  const toLevel = findLevel(to, levels);
  const fromLabel = fromLevel?.label ?? from;
  const toLabel = toLevel?.label ?? to;

  const blockers: ConversionBlocker[] = [];
  const effects: ConversionEffect[] = [];

  if (!toLevel) {
    return {
      from,
      fromLabel,
      to,
      toLabel,
      detachesParent: false,
      effects,
      blockers: [
        {
          kind: "unknown-level",
          message: `"${to}" is not one of this workspace's levels.`,
        },
      ],
    };
  }
  if (from === to) {
    return {
      from,
      fromLabel,
      to,
      toLabel,
      detachesParent: false,
      effects,
      blockers: [
        { kind: "same-level", message: `This is already a ${toLabel}.` },
      ],
    };
  }

  // ── Specs are leaf-only ───────────────────────────────────────────────────
  // `spec-content.ts` refuses to attach a spec anywhere but the leaf, because
  // sync would otherwise reconcile the row back down and strand its children.
  // Never detach a git-backed file as a side effect of a level change: say so
  // and let the author decide what happens to their file.
  if (input.item.specPath !== null && !toLevel.isLeaf) {
    blockers.push({
      kind: "spec-attached",
      message:
        `This item has a spec attached (${input.item.specPath}), and a spec can ` +
        `only live on ${withArticle(leafLabel(levels))}. Detach or delete the spec first; ` +
        `converting will not touch a file in git.`,
    });
  }

  // ── Children ──────────────────────────────────────────────────────────────
  // The same one-level rule that governs the parent applies downward. Promoting
  // a Feature to an Epic leaves its Work Items two levels below it.
  const stranded = input.children.filter(
    (c) => !isValidParentLevel(c.level, to, levels),
  );
  if (stranded.length > 0) {
    blockers.push({
      kind: "children-stranded",
      message:
        `${countLabel(stranded.length, "item")} under this one would no longer ` +
        `be allowed there: ${withArticle(toLabel)} holds ${pluralLabel(childLabelFor(to, levels))}. ` +
        `Move or convert them first.`,
      items: stranded,
    });
  } else if (input.children.length > 0) {
    effects.push({
      kind: "children-kept",
      message: `Its ${countLabel(input.children.length, "child item")} stay where they are.`,
    });
  }

  // ── Parent ────────────────────────────────────────────────────────────────
  // Offered rather than refused: almost every conversion invalidates the
  // current parent, so refusing here would refuse nearly everything.
  const parentStaysValid =
    input.parent === null || isValidParentLevel(to, input.parent.level, levels);
  const detachesParent = input.parent !== null && !parentStaysValid;
  if (detachesParent && input.parent) {
    const wanted = parentLevelKey(to, levels);
    effects.push({
      kind: "parent-detached",
      message: wanted
        ? `It stops being a child of "${input.parent.title}", because ${withArticle(toLabel)} ` +
          `sits under ${pluralLabel(labelFor(wanted, levels))} and that is ` +
          `${withArticle(labelFor(input.parent.level, levels))}. You can give it a new parent afterwards.`
        : `It stops being a child of "${input.parent.title}", because ${withArticle(toLabel)} is a top-level item.`,
    });
  } else if (input.parent) {
    effects.push({
      kind: "parent-kept",
      message: `It stays under "${input.parent.title}".`,
    });
  }

  // ── Custom properties ─────────────────────────────────────────────────────
  // Values are kept and hidden, never dropped: `custom_fields` is a bag keyed
  // by property, and the item view renders only the properties that apply at
  // its level. Converting back brings them straight back. This is the one place
  // where doing nothing is better than either alternative.
  const hidden = input.properties.filter(
    (p) =>
      propertyAppliesToLevel(p, from) &&
      !propertyAppliesToLevel(p, to) &&
      hasValue(input.record.customFields?.[p.key]),
  );
  if (hidden.length > 0) {
    effects.push({
      kind: "properties-hidden",
      message:
        `${namesOf(hidden.map((p) => p.label))} ${hidden.length === 1 ? "is" : "are"} not ` +
        `shown on ${withArticle(toLabel)}. The ${hidden.length === 1 ? "value is" : "values are"} kept, ` +
        `and come back if you convert it back.`,
    });
  }
  const shown = input.properties.filter(
    (p) => !propertyAppliesToLevel(p, from) && propertyAppliesToLevel(p, to),
  );
  if (shown.length > 0) {
    effects.push({
      kind: "properties-shown",
      message: `${namesOf(shown.map((p) => p.label))} become available.`,
    });
  }

  // ── Built-in field visibility ─────────────────────────────────────────────
  const lost = BUILTIN_METADATA_FIELDS.filter(
    (f) =>
      isFieldAvailable(fromLevel?.fields, f.key) &&
      !isFieldAvailable(toLevel.fields, f.key),
  );
  if (lost.length > 0) {
    effects.push({
      kind: "fields-lost",
      message: `${namesOf(lost.map((f) => f.label))} ${lost.length === 1 ? "is" : "are"} not shown on ${withArticle(toLabel)}.`,
    });
  }
  const gained = BUILTIN_METADATA_FIELDS.filter(
    (f) =>
      !isFieldAvailable(fromLevel?.fields, f.key) &&
      isFieldAvailable(toLevel.fields, f.key),
  );
  if (gained.length > 0) {
    effects.push({
      kind: "fields-gained",
      message: `${namesOf(gained.map((f) => f.label))} become available.`,
    });
  }

  // ── Detail template ───────────────────────────────────────────────────────
  // An existing body is never overwritten. Said out loud because the target
  // level having a template is the reason somebody would expect it to be.
  if (
    toLevel.detailTemplateId &&
    toLevel.detailTemplateId !== fromLevel?.detailTemplateId
  ) {
    effects.push({
      kind: "template-mismatch",
      message: `${sentenceCase(withArticle(toLabel))} starts from a details template. This item keeps the body it already has.`,
    });
  }

  // ── Stage gates ───────────────────────────────────────────────────────────
  // A field gate is satisfied by the item's own data, so a value already set
  // keeps satisfying it even once the field is hidden. The stranding case is an
  // *unsatisfied* field gate whose field the target level does not carry: the
  // item would sit in a status it could never advance out of, with no control
  // on screen to fix it.
  //
  // Checked for the current stage and every stage after it, because that is the
  // whole of the item's remaining path.
  const fromIndex = input.statuses.indexOf(input.item.status);
  const ahead = new Set(
    fromIndex >= 0 ? input.statuses.slice(fromIndex) : input.statuses,
  );
  const catalog = gateFieldCatalog([...input.properties]);
  const completed = new Set(input.completedGateIds);
  const unsatisfiable = input.gates.filter(
    (g) =>
      g.kind === "field" &&
      ahead.has(g.stageKey) &&
      !gateSatisfied(g, input.record, completed, catalog) &&
      !fieldReachableAt(g.fieldKey, to, toLevel, levels, input.properties),
  );
  if (unsatisfiable.length > 0) {
    blockers.push({
      kind: "gates-unsatisfiable",
      message:
        `${sentenceCase(withArticle(toLabel))} has no way to set ${unsatisfiable.length === 1 ? "a field" : "fields"} ` +
        `that a stage ahead of this item requires, so it would be stuck where it is. ` +
        `Set ${unsatisfiable.length === 1 ? "it" : "them"} first, or change the gate.`,
      gates: unsatisfiable.map(
        (g) =>
          `${gateDisplayLabel(g, catalog)} (${input.statusLabels[g.stageKey] ?? g.stageKey})`,
      ),
    });
  }

  return { from, fromLabel, to, toLabel, blockers, effects, detachesParent };
}

/**
 * Whether a field gate's field can still be set at `to`.
 *
 * Structural fields (release, cycle, parent) are always on the form, with one
 * exception that matters: a top-level item cannot have a parent at all, so a
 * `parent` gate there is unsatisfiable by construction rather than by config.
 */
function fieldReachableAt(
  fieldKey: string | null,
  to: string,
  toLevel: WorkspaceLevel,
  levels: readonly WorkspaceLevel[],
  properties: readonly PropertyDef[],
): boolean {
  if (!fieldKey) return true;
  if (fieldKey.startsWith(CUSTOM_FIELD_PREFIX)) {
    const key = fieldKey.slice(CUSTOM_FIELD_PREFIX.length);
    const property = properties.find((p) => p.key === key);
    // A gate naming a property that no longer exists is already broken, and
    // converting is not what broke it.
    return property ? propertyAppliesToLevel(property, to) : true;
  }
  if (fieldKey === "parent") return parentLevelKey(to, levels) !== null;
  if (BUILTIN_METADATA_FIELDS.some((f) => f.key === fieldKey)) {
    return isFieldAvailable(toLevel.fields, fieldKey);
  }
  return true;
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  return !(Array.isArray(v) && v.length === 0);
}

function labelFor(key: string, levels: readonly WorkspaceLevel[]): string {
  return findLevel(key, levels)?.label ?? key;
}

function leafLabel(levels: readonly WorkspaceLevel[]): string {
  return levels.at(-1)?.label ?? "leaf item";
}

function childLabelFor(key: string, levels: readonly WorkspaceLevel[]): string {
  const child = childLevelKey(key, levels);
  return child ? labelFor(child, levels) : "nothing";
}

/**
 * "an Epic", "a Feature".
 *
 * Levels are named by admins, so the article cannot be baked into the copy.
 * First-letter vowel is the wrong rule in general ("a Unit", "an Hour") and the
 * right one for the words that actually appear here; a message that reads "a
 * Epic" undoes the care in the rest of the sentence.
 */
function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pluralLabel(label: string): string {
  return /s$/i.test(label) ? label : `${label}s`;
}

function countLabel(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function namesOf(labels: string[]): string {
  if (labels.length === 1) return `"${labels[0]}"`;
  const quoted = labels.map((l) => `"${l}"`);
  const last = quoted.pop()!;
  return `${quoted.join(", ")} and ${last}`;
}
