import { accessRequests, sql, type Database } from "@specboards/db";

/**
 * Storage for the pre-v1 access-request queue: what the marketing site's
 * "Request access" form leaves behind.
 *
 * Recording is all this app does with the queue. Reviewing it, and approving a
 * request (which emails the requester the sign-up code), happen in the internal
 * admin portal, which reaches this table directly over the org's private
 * network with a role granted UPDATE on this one table. That keeps the product
 * app free of an admin API surface for a gate we expect to retire with the
 * pre-release beta.
 */

export interface AccessRequestInput {
  name: string;
  email: string;
  company: string;
  teamSize: string;
  useCase: string;
}

export interface AccessRequestRow {
  id: string;
  name: string;
  email: string;
  company: string;
  teamSize: string;
  useCase: string;
  status: "pending" | "approved" | "declined";
  decidedBy: string | null;
  decidedAt: Date | null;
  codeSentAt: Date | null;
  createdAt: Date;
}

/**
 * Record a submission, returning the stored row.
 *
 * A repeat submission from an address that already has a request open updates
 * that row rather than queueing a second one (partial unique index on `email`
 * where status is `pending`), so the reviewer sees one entry per person
 * carrying whatever they most recently told us. `createdAt` is deliberately
 * left alone on that path: the queue orders by "waiting since", and a
 * resubmission should not send someone back to the end of the line.
 */
export async function recordAccessRequest(
  db: Database,
  input: AccessRequestInput,
): Promise<AccessRequestRow> {
  const [row] = await db
    .insert(accessRequests)
    .values({
      name: input.name,
      email: input.email.trim().toLowerCase(),
      company: input.company,
      teamSize: input.teamSize,
      useCase: input.useCase,
    })
    .onConflictDoUpdate({
      target: accessRequests.email,
      targetWhere: sql`${accessRequests.status} = 'pending'`,
      set: {
        name: input.name,
        company: input.company,
        teamSize: input.teamSize,
        useCase: input.useCase,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row as AccessRequestRow;
}
