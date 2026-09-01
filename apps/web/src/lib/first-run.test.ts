import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasAnyUser, resetFirstRunCache } from "./first-run";
import type { Database } from "@specboards/db";

/**
 * This decides whether a visitor is sent to "sign in" or to "create the admin
 * account", so both wrong answers are user-visible: a false negative asks an
 * empty deployment for a password it cannot have, and a false positive invites
 * a stranger to create the first account on a live one. The failure case
 * matters most, since a database blip is when a wrong answer is most likely.
 */
function dbReturning(rows: unknown[]): { db: Database; calls: () => number } {
  let calls = 0;
  const limit = vi.fn(async () => {
    calls += 1;
    return rows;
  });
  const db = {
    select: () => ({ from: () => ({ limit }) }),
  } as unknown as Database;
  return { db, calls: () => calls };
}

function dbThatThrows(): Database {
  return {
    select: () => ({
      from: () => ({
        limit: async () => {
          throw new Error("connection refused");
        },
      }),
    }),
  } as unknown as Database;
}

describe("hasAnyUser", () => {
  beforeEach(() => resetFirstRunCache());

  it("is false when no account exists, which is the first-run case", async () => {
    const { db } = dbReturning([]);
    expect(await hasAnyUser(db)).toBe(false);
  });

  it("is true when an account exists", async () => {
    const { db } = dbReturning([{ one: 1 }]);
    expect(await hasAnyUser(db)).toBe(true);
  });

  it("stops querying once the answer is yes", async () => {
    const { db, calls } = dbReturning([{ one: 1 }]);
    await hasAnyUser(db);
    await hasAnyUser(db);
    await hasAnyUser(db);
    expect(calls()).toBe(1);
  });

  it("keeps asking while the answer is no, because that answer changes", async () => {
    const { db, calls } = dbReturning([]);
    await hasAnyUser(db);
    await hasAnyUser(db);
    expect(calls()).toBe(2);
  });

  it("reports true when the database cannot answer", async () => {
    // Failing toward "there are users" keeps a live deployment on the ordinary
    // signed-out path during an outage. Failing the other way would offer
    // "create the first account" on a deployment that already has thousands.
    expect(await hasAnyUser(dbThatThrows())).toBe(true);
  });

  it("does not cache the answer it gave on failure", async () => {
    await hasAnyUser(dbThatThrows());
    const { db } = dbReturning([]);
    expect(await hasAnyUser(db)).toBe(false);
  });
});
