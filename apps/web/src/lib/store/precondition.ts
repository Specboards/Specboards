import { createHash } from "node:crypto";

/**
 * Optimistic concurrency for the database-backed write paths.
 *
 * ── The hole this fills ───────────────────────────────────────────────────
 * Applying a proposal reads the target, checks the caller may change it and
 * that the proposal is not stale, and only then writes. Those are separate
 * transactions, so anything that happens in between is invisible to the
 * write: a person editing the same field between the check and the write has
 * their edit silently replaced. The adversarial review of `v1.0.0..0c364b6`
 * filed this as AR-03.
 *
 * A git-backed spec never had the problem, because it carries a blob sha down
 * to the write and `updateSpecContent` re-checks it there. This is the same
 * idea for the targets that have no blob: take a fingerprint of the columns
 * the write is about to change, carry it to the write, and re-check it under
 * the row lock that performs the write.
 *
 * ── Why the fingerprint is computed in one place ──────────────────────────
 * Both sides of the comparison come from `fingerprintOf` over columns picked
 * by `pick`, reading the same table through the same code. That is the whole
 * point of it living here rather than at each call site. A fingerprint taken
 * over a service-layer view and re-checked against raw columns would have to
 * agree about every shape question (a null tag list against an empty one, the
 * order of a custom-field map) with nothing to catch it when they stopped
 * agreeing: the failure is not a wrong answer, it is every write refusing
 * forever, discovered in production.
 *
 * ── Why a hash of the values and not `updated_at` ─────────────────────────
 * The same reason `contentVersion` gives: a row timestamp moves when a field
 * nobody is writing changes, so a precondition over it would refuse good
 * writes. It would also be a lie about precision, because `now()` keeps
 * microseconds and a JavaScript Date does not.
 */

/** A write was refused because the values it was prepared against moved. */
export class StaleWriteError extends Error {
  constructor(
    message: string,
    /** The field names whose values no longer match. */
    readonly fields: readonly string[],
  ) {
    super(message);
    this.name = "StaleWriteError";
  }
}

/**
 * Order-independent JSON, so a fingerprint means "these values" and not
 * "these values, serialised in this order".
 *
 * Object keys and array members are both sorted. Tags force it: the same
 * three tags coming back in a different order between two reads would read as
 * a change, and every write against that item would then refuse forever.
 * `undefined` and `null` collapse together, because a column that is absent
 * from a projection and one that is SQL NULL are the same fact here.
 */
export function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(stable)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = stable(src[key]);
    return out;
  }
  return value ?? null;
}

/**
 * A fingerprint of just the named fields of a row.
 *
 * Narrow on purpose, and the field list is always the fields the write is
 * about to change. Fingerprinting the whole row would mean a write that sets
 * a tag refused because somebody else set the assignee, which is two people
 * not colliding being told that they did.
 */
export function fingerprintOf(
  row: Record<string, unknown>,
  fields: readonly string[],
): string {
  const snapshot: Record<string, unknown> = {};
  for (const field of [...fields].sort()) snapshot[field] = stable(row[field]);
  return createHash("sha256")
    .update(JSON.stringify(snapshot), "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Refuse the write when the row moved after the fingerprint was taken.
 *
 * `expected` of `undefined` means the caller did not ask for the check, which
 * is every caller that is not applying something prepared earlier. An ordinary
 * edit is a person acting on what they are looking at now, and making them
 * carry a version would turn a last-write-wins field into a conflict dialog.
 */
export function assertUnchanged(
  expected: string | undefined,
  row: Record<string, unknown>,
  fields: readonly string[],
  subject: string,
): void {
  if (expected === undefined) return;
  assertSameFingerprint(expected, fingerprintOf(row, fields), subject, fields);
}

/**
 * The same refusal, for a caller that has already computed both fingerprints.
 *
 * Item conversion needs this: what it fingerprints is not one row's columns
 * but a neighbourhood (the item, its parent, its children, whether a spec is
 * attached), so it builds its own and has nothing to hand {@link
 * assertUnchanged}. Sharing the refusal rather than the computation keeps one
 * wording for one situation.
 */
export function assertSameFingerprint(
  expected: string | undefined,
  actual: string | null,
  subject: string,
  fields: readonly string[] = [],
): void {
  if (expected === undefined) return;
  if (expected === actual) return;
  throw new StaleWriteError(
    `This ${subject} changed while the change was being applied, so applying ` +
      `it would replace that newer version. Nothing was written. Review where ` +
      `the ${subject} is now and try again.`,
    fields,
  );
}
