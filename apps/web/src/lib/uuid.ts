/** Canonical 8-4-4-4-12 hex form, which is all a Postgres `uuid` column takes. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is a uuid in the canonical spelling.
 *
 * Deliberately strict: a prefix, an unhyphenated run of 32 hex digits, or a
 * braced/urn form would all mean guessing which row the caller meant. Being
 * strict here is also what keeps a malformed id from reaching the driver, where
 * the rejection arrives as an error quoting the whole statement.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
