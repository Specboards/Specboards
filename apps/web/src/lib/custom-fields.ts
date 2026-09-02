import type { PropertyDef } from "@specboards/core";
import type { CustomFieldValue } from "@/lib/store";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * Validating user-defined custom field values against their declared property.
 *
 * Shared because items and releases both carry custom fields and both must
 * agree on what a `date` or a `select` accepts. A copy on each side is a
 * divergence waiting to happen, and the direction it would fail in is the bad
 * one: a value the item surface rejects and the release surface stores.
 */

/** Validate an untrusted custom-fields map: a flat object of scalar/string[] values. */
export function parseCustomFields(value: unknown): Record<string, CustomFieldValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidPatchError("customFields must be a JSON object.");
  }
  const out: Record<string, CustomFieldValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      raw === null ||
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      (Array.isArray(raw) && raw.every((v) => typeof v === "string"))
    ) {
      out[key] = raw as CustomFieldValue;
    } else {
      throw new InvalidPatchError(
        `customFields.${key} must be a string, number, boolean, string[], or null.`,
      );
    }
  }
  return out;
}

/** Whether `value` is a real calendar date in `YYYY-MM-DD` form. */
function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Enforce declared custom-property types on the values being written. Only
 * `date` is checked today (it must be a real ISO `YYYY-MM-DD`), so a date field
 * is trustworthy to sort and, later, to plot on a timeline. Values for unknown
 * keys or untyped-here properties pass through (structural checks already ran
 * in {@link parseCustomFields}). A `null` clears a field and is always allowed.
 */
export function assertCustomFieldTypes(
  customFields: Record<string, CustomFieldValue>,
  properties: PropertyDef[],
): void {
  const typeByKey = new Map(properties.map((p) => [p.key, p.type]));
  for (const [key, value] of Object.entries(customFields)) {
    if (value === null) continue;
    if (typeByKey.get(key) === "date") {
      if (typeof value !== "string" || !isIsoDate(value)) {
        throw new InvalidPatchError(
          `customFields.${key} must be a date in YYYY-MM-DD format.`,
        );
      }
    }
  }
}
