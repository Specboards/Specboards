import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Recording a "Request access" submission from the marketing site.
 *
 * Against a real Postgres because the part worth testing is what the database
 * enforces: the partial unique index that collapses a resubmission into the
 * request already open for that address, rather than growing the reviewer a
 * duplicate. A fake would only restate the code.
 *
 * Deciding a request (approve / decline, and the email that carries the sign-up
 * code) lives in the admin portal, not here.
 *
 * Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("recordAccessRequest", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let recordAccessRequest: typeof import("./access-requests-service").recordAccessRequest;
  const emails: string[] = [];

  /** An address unique per test, cleaned up afterwards. */
  function newEmail(): string {
    const email = `access-test-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  }

  function submission(email: string) {
    return {
      name: "Ada Lovelace",
      email,
      company: "Analytical Engines",
      teamSize: "2-10",
      useCase: "Tracking specs that already live in our repo.",
    };
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    ({ recordAccessRequest } = await import("./access-requests-service"));
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
  });

  afterEach(async () => {
    if (emails.length) {
      await sql`delete from access_requests where email = any(${emails})`;
      emails.length = 0;
    }
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("records a request as pending", async () => {
    const email = newEmail();
    const row = await recordAccessRequest(db, submission(email));
    expect(row.status).toBe("pending");
    expect(row.email).toBe(email);
    expect(row.company).toBe("Analytical Engines");
    expect(row.decidedAt).toBeNull();
  });

  it("lowercases the stored address", async () => {
    const email = newEmail();
    const row = await recordAccessRequest(db, {
      ...submission(email),
      email: email.toUpperCase(),
    });
    expect(row.email).toBe(email);
  });

  it("refreshes the open request instead of queueing a duplicate", async () => {
    const email = newEmail();
    const first = await recordAccessRequest(db, submission(email));
    const second = await recordAccessRequest(db, {
      ...submission(email),
      company: "Difference Engines",
      useCase: "Second thoughts, described at length.",
    });

    expect(second.id).toBe(first.id);
    expect(second.company).toBe("Difference Engines");
    // Resubmitting must not send someone back to the end of the queue.
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());

    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count from access_requests where email = ${email}`;
    expect(rows[0]?.count).toBe(1);
  });

  it("lets a decided requester open a new request", async () => {
    const email = newEmail();
    const first = await recordAccessRequest(db, submission(email));
    // Stands in for the portal deciding it; the partial index only constrains
    // rows that are still pending.
    await sql`update access_requests set status = 'declined' where id = ${first.id}`;

    const second = await recordAccessRequest(db, submission(email));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
  });
});
