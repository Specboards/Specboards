import { sql, users, type Database } from "@specboards/db";

/**
 * Does this deployment have any account at all?
 *
 * A freshly installed self-host has none, and until this existed the app did
 * not distinguish that state from "signed out". `/` redirected to `/sign-in`,
 * so the operator met "Welcome back to Specboards." and a password form against
 * an empty database, with sign-up demoted to a small link underneath. It also
 * contradicted the last thing they had read: `setup.sh` finishes by saying
 * "Open it and create your account; the first account becomes the admin."
 *
 * ── Why the cached true is safe ────────────────────────────────────────────
 * This is a one-way door. A deployment goes from zero accounts to some
 * accounts exactly once and never back (deleting every user is not a supported
 * operation, and would leave a workspace nobody can reach regardless). So once
 * the answer is "yes" it can be memoized for the life of the process, and the
 * query stops running entirely. A `false` is never cached, because that is the
 * answer that changes.
 *
 * The query itself is `select 1 ... limit 1`, not a count: the question is
 * whether any row exists, and on a large hosted workspace counting every user
 * to learn "at least one" would be wasteful on a path that runs before auth.
 */
let knownToHaveUsers = false;

export async function hasAnyUser(db: Database): Promise<boolean> {
  if (knownToHaveUsers) return true;
  try {
    const rows = await db.select({ one: sql<number>`1` }).from(users).limit(1);
    const any = rows.length > 0;
    if (any) knownToHaveUsers = true;
    return any;
  } catch {
    // A database that cannot answer must not be reported as empty: that would
    // route a live deployment's users to "create the first account" during an
    // outage. Fail toward the ordinary signed-out experience.
    return true;
  }
}

/** Reset the memo. Tests only; production has no path that un-creates users. */
export function resetFirstRunCache(): void {
  knownToHaveUsers = false;
}
