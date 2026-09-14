import { portalEmailOptOuts } from "@specboards/db";

import { getDb } from "@/lib/db";

/**
 * Recording that somebody with no account wants no more portal mail.
 *
 * ── Why this is `lib/portal-intake/` and not `lib/portal/` ─────────────────
 * Same boundary as `vote.ts` next door, and the guard enforced it: `lib/portal`
 * is the READ side, everything in it runs on `getPortalDb()`, and
 * `portal-auth-isolation.test.ts` forbids `getDb` there because the owner
 * connection bypasses the row-level security that decides what a stranger sees.
 *
 * An opt-out is a write, and the portal role holds no INSERT by design, so it
 * has to be the owner connection. Putting it here rather than exempting the
 * rule keeps the one module that reaches for the unpoliced connection somewhere
 * a reviewer notices.
 *
 * ── What bounds it ─────────────────────────────────────────────────────────
 * The workspace comes from the signed token, and the caller has already checked
 * that it matches the portal being addressed. So the only row this can write is
 * an opt-out, for the address the token names, in the workspace whose mail that
 * address actually received.
 */
export async function recordPortalUnsubscribe(
  workspaceId: string,
  email: string,
): Promise<void> {
  const address = email.trim().toLowerCase();
  if (!address) return;

  const db = getDb();
  if (!db) throw new Error("No database configured for the portal opt-out.");

  // Idempotent. Clicking the link twice, or a mail scanner fetching it and then
  // the recipient clicking it, must both leave exactly one row. Untargeted
  // because `portal_email_opt_outs_ws_email_uq` is the only unique index it
  // could hit, and that index is case-folded, which is why the address is
  // lower-cased above rather than trusted as typed.
  await db
    .insert(portalEmailOptOuts)
    .values({ workspaceId, email: address })
    .onConflictDoNothing();
}
