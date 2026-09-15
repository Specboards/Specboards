import { and, eq, inArray, isNull, members } from "@specboards/db";

import { getDb } from "@/lib/db";

/**
 * What makes a workspace member an agent rather than a person.
 *
 * One definition, used from two layers: the store resolves it inside the
 * transaction that writes a comment, and the feature service resolves it on
 * the owner connection before it decides which events an assignment raises.
 * Exported as a condition rather than as a function that runs a query,
 * because those two callers hold different connections and the thing worth
 * sharing is the RULE, not the plumbing around it.
 *
 * ── Why `deactivatedAt` is part of it ─────────────────────────────────────
 * A retired service account is still a row, and items assigned to it before
 * it was retired still carry its id. Dispatching to it would be raising
 * events nothing is listening for and, worse, telling the board an agent is
 * about to pick something up when nothing is. A deactivated agent is not an
 * agent for the purpose of sending it work; it stays an agent for the purpose
 * of reading history, which is why nothing here rewrites old rows.
 */
export function activeAgentsAmong(workspaceId: string, userIds: string[]) {
  return and(
    eq(members.workspaceId, workspaceId),
    inArray(members.userId, userIds),
    // `service` is the machine-account role: see `memberRole` in the schema.
    // It behaves like a member for product-scoped writes and is surfaced
    // distinctly so automated activity is never attributed to a person.
    eq(members.role, "service"),
    isNull(members.deactivatedAt),
  );
}

/**
 * Whether one user id is an agent this workspace can currently dispatch to.
 *
 * On the owner connection rather than the caller's, matching how membership
 * is read everywhere else (`workspace.ts`, `org-members-service.ts`):
 * membership is auth data, and the answer must not depend on what the acting
 * user can see. It is also the reason this is safe to call from a service
 * that holds no transaction.
 *
 * `false` when there is no database, which is local file mode, where there
 * are no service accounts and nothing to dispatch to.
 */
export async function isActiveAgent(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select({ userId: members.userId })
    .from(members)
    .where(activeAgentsAmong(workspaceId, [userId]))
    .limit(1);
  return rows.length > 0;
}
