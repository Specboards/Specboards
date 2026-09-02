import { InvalidPatchError } from "@/lib/service-errors";

/**
 * The input primitives the three planning resources share.
 *
 * Releases, cycles, and goals each accept a product, a pair of dates, and a
 * free-text note, and each must reject the same malformed values with the same
 * message. They sit here rather than in `releases-service` because a cycle
 * parser reaching into the release module to validate a date reads as a
 * mistake, and because it would make releases the hub of the planning graph
 * without earning it.
 */

/** Validate a productId: a non-empty string (product uuid) or null (portfolio). */
export function parseProductId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError("productId must be a string or null.");
  }
  return value;
}

/** Validate release notes: a string (trimmed; empty becomes null) or null. */
export function parseNotes(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError("notes must be a string or null.");
  }
  const trimmed = value.trim();
  if (trimmed.length > 10_000) {
    throw new InvalidPatchError("notes must be 10,000 characters or fewer.");
  }
  return trimmed || null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new InvalidPatchError(`${field} must be YYYY-MM-DD or null.`);
  }
  return value;
}
