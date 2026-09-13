import { ideaVotes } from "@specboards/db";

import { getDb } from "@/lib/db";
import { isLocalFileMode } from "@/lib/local-mode";
import type { LocalStoreContext } from "@/lib/store/local/context";

import { readPortalIdea } from "@/lib/portal/ideas";
import type { PortalContext } from "@/lib/portal/resolve";

/**
 * Recording an anonymous vote, once the address behind it is confirmed.
 *
 * Called from two places that have earned the address differently: the
 * confirmation link (which just proved control of the mailbox) and the vote
 * endpoint (which is trusting a signed cookie from an earlier confirmation).
 * Both funnel here so the checks below cannot be true of one path and not the
 * other.
 *
 * ── Why this is `lib/portal-intake/` and not `lib/portal/` ─────────────────
 * It moved here because `portal-auth-isolation.test.ts` failed it, and the test
 * was right to.
 *
 * `lib/portal/` is the READ side: everything in it runs on `getPortalDb()`,
 * where RLS decides what a stranger may see, and the guard forbids `getDb` in
 * there because the owner connection bypasses exactly that. A vote is a WRITE,
 * the portal role holds no INSERT by design (`infra/portal-role.sql` calls that
 * load-bearing), so this has to use the owner connection and cannot live under
 * that rule.
 *
 * The separate directory is the point rather than a workaround. It marks the
 * one module that reaches for the unpoliced connection on behalf of an
 * anonymous visitor, so it is a thing somebody notices in a diff instead of a
 * line hidden among the read paths.
 *
 * What keeps the bargain honest is that every input to the write is bounded by
 * a read that RLS *did* police: `readPortalIdea` below runs on the portal
 * connection, and both the workspace and the publication check come from it.
 * The owner connection is used to insert one row and to decide nothing.
 */

/**
 * What happened, so the caller can say something true to the visitor.
 *
 * Not exported: both callers switch on the value inline rather than naming the
 * type, so an exported version is dead by `knip`'s reckoning and it is right.
 */
type VoteOutcome =
  | { ok: true; alreadyVoted: boolean }
  /** The idea is not one this portal publishes, or does not exist. */
  | { ok: false; reason: "not-found" };

/**
 * Record `email`'s vote on `ideaId`.
 *
 * ── The publication check is not optional, and not the caller's job ────────
 * A vote token names an idea id, and an id outlives the idea's publication: a
 * moderator can hide a submission, or withdraw a stage, between the mail going
 * out and the link being clicked. Without this, a stale link would insert a row
 * against an idea the portal no longer shows, and the count would then be wrong
 * the moment it was published again.
 *
 * `readPortalIdea` answers it on the PORTAL connection, where RLS already
 * refuses an unpublished product, an unpublished stage and a pending or hidden
 * moderation state. So the same rules that decide what a visitor may READ
 * decide what they may vote on, with no second copy of them here to drift.
 */
export async function recordPortalVote(
  portal: PortalContext,
  ideaId: string,
  email: string,
): Promise<VoteOutcome> {
  const idea = await readPortalIdea(portal, ideaId);
  if (!idea) return { ok: false, reason: "not-found" };

  const address = email.trim().toLowerCase();
  if (!address) return { ok: false, reason: "not-found" };

  if (isLocalFileMode()) {
    // Straight to the local ideas module rather than through the `Store`
    // interface, for the same reason the DB branch below goes straight to
    // `getDb()`: every store method takes a `WorkspaceScope` naming a user, and
    // a portal voter has none. The DB store is also built on the RLS
    // connection, whose policies would refuse an anonymous insert outright.
    //
    // The local store keys votes by an opaque string, so a confirmed address is
    // as valid a voter as `LOCAL_USER`. Deduplication is the same `includes`
    // check the member path uses, which is exactly as good here: one process on
    // loopback, no concurrent writer to race.
    const { addAnonymousVote } = await import("@/lib/store/local/ideas");
    const { findRepoRoot } = await import("@/lib/store/local");
    const result = await addAnonymousVote(
      { root: await findRepoRoot() } as LocalStoreContext,
      ideaId,
      address,
    );
    return result.found
      ? { ok: true, alreadyVoted: result.alreadyVoted }
      : { ok: false, reason: "not-found" };
  }

  const db = getDb();
  if (!db) return { ok: false, reason: "not-found" };

  // Idempotent, via an UNTARGETED `on conflict do nothing`.
  //
  // The index this needs to hit is `idea_votes_idea_email_uq`, which migration
  // 0010 defined on `(idea_id, lower(voter_email)) where voter_email is not
  // null`. Naming it as a conflict target is not expressible here: Drizzle's
  // `target` takes columns, and this one is on an EXPRESSION. Writing the
  // insert as raw SQL to say `on conflict (idea_id, lower(voter_email)) where
  // ...` would work and is not worth it.
  //
  // Untargeted is safe on this table specifically, which is why it is used
  // rather than tolerated. Three constraints could fire: the primary key
  // (impossible, `gen_random_uuid`), the member partial index (does not apply,
  // `user_id` is null here), and the email one. So "any conflict" and "that
  // conflict" are the same set, and if a fourth is ever added this comment is
  // the thing that should stop it being added silently.
  //
  // The index is case-folded, which is why the address is lower-cased above:
  // a second vote from `Ada@` after `ada@` is a no-op rather than a duplicate.
  const inserted = await db
    .insert(ideaVotes)
    .values({
      workspaceId: portal.workspaceId,
      ideaId,
      userId: null,
      voterEmail: address,
    })
    .onConflictDoNothing()
    .returning({ id: ideaVotes.id });

  // Nothing returned means the conflict fired, which means this address had
  // already voted. Not an error: a replayed link and an impatient second click
  // both land here, and both should look like success to the visitor.
  return { ok: true, alreadyVoted: inserted.length === 0 };
}
