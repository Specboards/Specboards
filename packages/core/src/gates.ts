

/**
 * Field-backed stage gates: which fields can be required, and what counts as
 * populated.
 *
 * In core rather than in the web app because two independent code paths enforce
 * gates against two different row shapes: `features-service.ts` over the store,
 * and the MCP server's `update_status` over its own Drizzle queries. Those two
 * were already asked to "keep in sync" by hand for checklist gates, which is a
 * comment rather than a mechanism. A gate that blocks an agent but not a person
 * (or the reverse) is exactly the failure a shared definition prevents.
 */

/** Prefix marking a custom property key inside a field key. */
export const CUSTOM_GATE_FIELD_PREFIX = "cf:";

/** A field a stage gate can require. */
export interface GateField {
  /** Built-in key, or a custom property key prefixed `cf:`. */
  key: string;
  label: string;
  /** Grouping for the picker; not otherwise meaningful. */
  group: "Built-in" | "Custom properties";
}

/**
 * The built-in fields worth requiring: the structural ones an item can be
 * missing and a reviewer would care about.
 *
 * Deliberately not `status` (it is what the gate is guarding), `title` (never
 * empty) or the RICE inputs (a score is a prioritization aid, and requiring one
 * before work can start is a policy nobody has asked for; it stays additive).
 */
export const BUILTIN_GATE_FIELDS: readonly GateField[] = [
  { key: "assignee", label: "Assignee", group: "Built-in" },
  { key: "release", label: "Release", group: "Built-in" },
  { key: "cycle", label: "Cycle", group: "Built-in" },
  { key: "parent", label: "Parent item", group: "Built-in" },
  { key: "tags", label: "Tags", group: "Built-in" },
];

/**
 * Every field a gate may require, given the workspace's item properties.
 *
 * `entity` is plain `string` rather than `PropertyEntity` so a raw Drizzle row
 * (whose text column is typed `string`) can be passed straight in; the filter
 * below is the same either way.
 */
export function gateFieldCatalog(
  properties: readonly { key: string; label: string; entity: string }[],
): GateField[] {
  return [
    ...BUILTIN_GATE_FIELDS,
    ...properties
      .filter((p) => p.entity === "item")
      .map((p) => ({
        key: `${CUSTOM_GATE_FIELD_PREFIX}${p.key}`,
        label: p.label,
        group: "Custom properties" as const,
      })),
  ];
}

/**
 * The parts of an item a field gate reads.
 *
 * Structural rather than the web app's `FeatureRecord`, so the MCP server can
 * satisfy it from a raw `features` row (whose parent column is `parentId`) with
 * no adapter beyond naming.
 */
export interface GateSubject {
  assigneeId: string | null;
  releaseId: string | null;
  cycleId: string | null;
  parentId: string | null;
  tags: readonly string[];
  customFields: Readonly<Record<string, unknown>>;
}

/** Whether a stored custom-property value counts as populated. */
function customValueIsSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  // A number of 0 and a checkbox of false are answers, not absences: somebody
  // set them. Treating false as unset would make a required checkbox
  // impossible to satisfy with a No, which is not what "must be populated"
  // means anywhere else in the product.
  return true;
}

/**
 * Whether the item satisfies a field requirement right now.
 *
 * A gate naming a field that is not in the catalog is deliberately NOT
 * satisfied. The alternative (unknown means met) would let deleting a custom
 * property silently switch off an exit criterion with nothing anywhere saying
 * so. This way the item shows an unsatisfiable gate by name and an admin
 * removes it on purpose.
 */
export function fieldGateSatisfied(
  fieldKey: string,
  subject: GateSubject,
  catalog: readonly GateField[],
): boolean {
  if (!catalog.some((f) => f.key === fieldKey)) return false;
  if (fieldKey.startsWith(CUSTOM_GATE_FIELD_PREFIX)) {
    return customValueIsSet(
      subject.customFields[fieldKey.slice(CUSTOM_GATE_FIELD_PREFIX.length)],
    );
  }
  switch (fieldKey) {
    case "assignee":
      return subject.assigneeId !== null;
    case "release":
      return subject.releaseId !== null;
    case "cycle":
      return subject.cycleId !== null;
    case "parent":
      return subject.parentId !== null;
    case "tags":
      return subject.tags.length > 0;
    default:
      // In the catalog but with no case here: a built-in was added to
      // BUILTIN_GATE_FIELDS without a rule. Refuse rather than pass, for the
      // same reason as the unknown-field branch above.
      return false;
  }
}

/**
 * What to call a required field on screen.
 *
 * Resolved from the live catalog rather than read off the gate, so renaming a
 * custom property renames it everywhere it is enforced. `fallback` is the label
 * stored on the gate when it was created, which is all a gate pointing at a
 * deleted property has left; "Target End Date (no longer exists)" is far more
 * use to whoever has to fix it than an opaque key.
 */
export function gateFieldLabel(
  fieldKey: string,
  catalog: readonly GateField[],
  fallback?: string,
): string {
  const known = catalog.find((f) => f.key === fieldKey);
  if (known) return known.label;
  const bare = fieldKey.startsWith(CUSTOM_GATE_FIELD_PREFIX)
    ? fieldKey.slice(CUSTOM_GATE_FIELD_PREFIX.length)
    : fieldKey;
  return `${fallback || bare} (no longer exists)`;
}
