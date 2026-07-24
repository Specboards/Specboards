/**
 * Workspace-defined custom item properties (Settings -> Cards). Admins define
 * a property once (label + type + options) and choose which hierarchy levels
 * it applies to; values are stored per item in `features.custom_fields`,
 * keyed by the property's stable `key`.
 */

export const PROPERTY_TYPES = [
  "text",
  "number",
  "select",
  "multiselect",
  "date",
  "user",
  "url",
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

export function isPropertyType(value: unknown): value is PropertyType {
  return (
    typeof value === "string" &&
    (PROPERTY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The kind of record a custom property is defined for. Item properties attach
 * to work items (scoped further by hierarchy `levels`); release properties
 * attach to releases (which have no level, so `levels` is null for them).
 */
export const PROPERTY_ENTITIES = ["item", "release"] as const;

export type PropertyEntity = (typeof PROPERTY_ENTITIES)[number];

export function isPropertyEntity(value: unknown): value is PropertyEntity {
  return (
    typeof value === "string" &&
    (PROPERTY_ENTITIES as readonly string[]).includes(value)
  );
}

/** A custom property definition as the UI consumes it. */
export interface PropertyDef {
  /** Row id (uuid in db mode), used to update/delete the definition. */
  id: string;
  /** Stable value key into `features.custom_fields`; derived from the label. */
  key: string;
  label: string;
  type: PropertyType;
  /** Which record the property is defined for: work items or releases. */
  entity: PropertyEntity;
  /** Choices for select/multiselect; empty for other types. */
  options: string[];
  /** Level keys the property applies to; null = every level. Always null for
   * release-scoped properties (releases have no hierarchy level). */
  levels: string[] | null;
  /** Manual ordering in forms and settings; ascending. */
  position: number;
}

/** Whether a property applies to items at `levelKey` (null levels = all). */
export function propertyAppliesToLevel(
  property: Pick<PropertyDef, "levels">,
  levelKey: string,
): boolean {
  return property.levels == null || property.levels.includes(levelKey);
}

/** Derive a stable property key from a label, unique against `taken`. */
export function propertyKeyFromLabel(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "property";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}
