import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `mail_settings` against a real Postgres.
 *
 * One claim, and it is the reason the table is shaped the way it is: the
 * tenant role cannot reach it. Mail transport is the credential every
 * transactional message leaves through, so a workspace-scoped connection being
 * able to read or write it would let one tenant re-point every other tenant's
 * verification links and invitations at a relay they control.
 *
 * Worth a database test rather than a reading of the migration, because the
 * grant this depends on is a *revoke* against a default privilege granted
 * elsewhere. `infra/rls-role.sql` gives specboards_app every table in the
 * schema, including ones created later, so the lock here is the absence of
 * something rather than the presence of it, and absence is what regresses
 * quietly.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "mail_int_app";
const APP_PASSWORD = "mail-int-only-not-a-real-secret";

describe.skipIf(!OWNER_URL)("mail_settings access", () => {
  let owner: postgres.Sql;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    // Provision specboards_app exactly as an operator would, so the default
    // privileges this test is checking the revoke against are really in force.
    const rlsRole = join(process.cwd(), "..", "..", "infra", "rls-role.sql");
    await owner.unsafe(readFileSync(rlsRole, "utf8"));

    await owner.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${APP_PASSWORD}';
        end if;
      end $$;
      grant specboards_app to ${APP_ROLE};
    `);
  });

  afterAll(async () => {
    await owner.end({ timeout: 5 });
  });

  it("does not let the tenant role read the transport or its credentials", async () => {
    const [row] = await owner`
      select has_table_privilege('specboards_app', 'mail_settings', 'SELECT') as ok`;
    expect(row!.ok).toBe(false);
  });

  it("does not let the tenant role write it either", async () => {
    for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
      const [row] = await owner`
        select has_table_privilege('specboards_app', 'mail_settings', ${priv}) as ok`;
      expect(row!.ok, `${priv} should be revoked`).toBe(false);
    }
  });

  it("refuses an actual select from a connection holding that role", async () => {
    // The privilege check above reads the catalogue; this reads the table, so
    // a grant arriving by some other path (a group role, a later script) still
    // shows up as a failure here.
    const app = postgres(appUrlFrom(OWNER_URL!), { prepare: false, max: 1 });
    try {
      await expect(app`select 1 from mail_settings limit 1`).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it("still allows the owner connection, which is what actually sends mail", async () => {
    const rows = await owner`select count(*)::int as n from mail_settings`;
    expect(typeof rows[0]!.n).toBe("number");
  });

  it("holds at most one row", async () => {
    // Enforced by a unique constant column. A second row that the reader
    // silently ignored would present as "I saved the settings and nothing
    // changed", which is the worst kind of support call.
    await owner`delete from mail_settings`;
    await owner`insert into mail_settings (transport, from_address, postmark_token)
      values ('postmark', 'a@example.com', 'blob')`;
    await expect(
      owner`insert into mail_settings (transport, from_address, postmark_token)
        values ('postmark', 'b@example.com', 'blob')`,
    ).rejects.toThrow(/duplicate key|unique/i);
    await owner`delete from mail_settings`;
  });

  it("refuses a row whose transport is missing its own fields", async () => {
    // The check constraint, which exists so a row cannot be written that the
    // sender would then fail on at the moment somebody is waiting for a
    // verification link.
    await expect(
      owner`insert into mail_settings (transport, from_address)
        values ('smtp', 'a@example.com')`,
    ).rejects.toThrow(/mail_settings_transport_complete/);
    await expect(
      owner`insert into mail_settings (transport, from_address)
        values ('postmark', 'a@example.com')`,
    ).rejects.toThrow(/mail_settings_transport_complete/);
  });
});

function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}
