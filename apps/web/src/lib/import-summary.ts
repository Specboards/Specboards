/**
 * Turning a sync summary into what the import prompt is allowed to claim.
 *
 * `SyncSummary.upserted` counts every spec written to the database, which is
 * the specs that are new *plus* every spec whose file changed since the last
 * sync. The onboarding panel reported that number as "Imported N specs" right
 * after a button that said "Create M cards", and the two had no reason to
 * agree: pressing "Create 2 cards" on a repository whose specs were already
 * imported created none and reported one.
 *
 * Splitting the number is what makes the sentence true. `attached` is the
 * count of specs that found an existing work item, so the rest of `upserted`
 * is the count of items sync actually inserted.
 */

/**
 * Split a sync summary into cards created and cards updated.
 *
 * `created` is the number the "Create N cards" button promised; `updated` is
 * existing items refreshed from git, which the button never claimed.
 *
 * Clamped at zero rather than trusting the arithmetic: `upserted` and
 * `attached` are incremented at different points in the reconcile loop, and a
 * negative "created" rendered as "Created -1 cards" would be a worse failure
 * than an undercount.
 */
export function importCounts(summary: { upserted: number; attached: number }): {
  created: number;
  updated: number;
} {
  return {
    created: Math.max(summary.upserted - summary.attached, 0),
    updated: summary.attached,
  };
}
