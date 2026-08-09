import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Database } from "@specboards/db";

import {
  deleteGithubUserToken,
  getGithubConnection,
  storeGithubUserToken,
} from "./github-user-token";

/**
 * Storage of per-user GitHub tokens.
 *
 * These are the first credentials this product holds that can write to someone
 * else's repository, so what is asserted here is the handling rather than the
 * happy path:
 *
 * - the raw token never reaches the column, so a database disclosure alone does
 *   not yield a usable credential
 * - reconnecting replaces rather than stacks, including when it is a different
 *   GitHub account, so the newest consent is the only one that can be used
 * - a connection is per workspace, so one membership's grant cannot be spent by
 *   another tenant
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const wsId = randomUUID();
const otherWsId = randomUUID();
const userId = randomUUID();
const colleagueId = randomUUID();
const suffix = randomUUID().slice(0, 8);

/** The non-owner role the RLS suites provision; provisioned here too so this
 * file does not depend on running after them. */
const APP_ROLE = "rls_int_app";
const APP_PASSWORD = "rls-int-only-not-a-real-secret";

function appUrl(): string {
  const url = new URL(OWNER_URL!);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

const RAW = "ghu_averysecrettokenvalue000000000000000";

function token(over: Partial<Parameters<typeof storeGithubUserToken>[4]> = {}) {
  return {
    accessToken: RAW,
    refreshToken: "ghr_arefreshtokenvalue0000000000000000",
    accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    refreshTokenExpiresAt: new Date("2030-06-01T00:00:00.000Z"),
    ...over,
  };
}

describe.skipIf(!OWNER_URL)("github user token storage", () => {
  let owner: postgres.Sql;
  let db: Database;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);
    await owner`insert into workspaces (id, name, slug) values
      (${wsId}, 'Tokens', ${"tokens-int-" + suffix}),
      (${otherWsId}, 'Tokens Two', ${"tokens2-int-" + suffix})`;
    await owner`insert into users (id, name, email, email_verified) values
      (${userId}, 'Jane Doe', ${`jane-${suffix}@example.com`}, true),
      (${colleagueId}, 'Sam Colleague', ${`sam-${suffix}@example.com`}, true)`;
    await owner.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${APP_PASSWORD}';
        end if;
      end $$;
      grant usage on schema public to ${APP_ROLE};
      grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
      grant usage, select on all sequences in schema public to ${APP_ROLE};
      grant execute on all functions in schema public to ${APP_ROLE};
    `);
  });

  afterAll(async () => {
    await owner`delete from users where id in (${userId}, ${colleagueId})`;
    await owner`delete from workspaces where id in (${wsId}, ${otherWsId})`;
    await owner.end({ timeout: 5 });
  });

  it("never writes the raw token to the column", async () => {
    await storeGithubUserToken(db, wsId, userId, "janedoe", token());

    const rows = await owner`select access_token, refresh_token
      from github_user_tokens where workspace_id = ${wsId} and user_id = ${userId}`;
    expect(rows).toHaveLength(1);
    // The whole point of encrypting at rest: reading the table is not enough.
    expect(rows[0]!.access_token).not.toContain(RAW);
    expect(rows[0]!.refresh_token).not.toContain("ghr_");
    // And it is not merely encoded: base64 of the raw value would "pass" the
    // check above while being trivially reversible.
    expect(rows[0]!.access_token).not.toContain(
      Buffer.from(RAW).toString("base64"),
    );
  });

  it("reports whose account is connected without exposing the token", async () => {
    const connection = await getGithubConnection(db, wsId, userId);
    expect(connection?.githubLogin).toBe("janedoe");
    expect(JSON.stringify(connection)).not.toContain(RAW);
  });

  it("replaces on reconnect rather than stacking a second grant", async () => {
    await storeGithubUserToken(db, wsId, userId, "jane-new-account", token());
    const rows = await owner`select github_login from github_user_tokens
      where workspace_id = ${wsId} and user_id = ${userId}`;
    // A second row would mean an old, possibly unwanted grant stayed usable.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.github_login).toBe("jane-new-account");
  });

  it("keeps a connection to one workspace out of another", async () => {
    expect(await getGithubConnection(db, otherWsId, userId)).toBeNull();
  });

  it("forgets a connection on disconnect", async () => {
    await deleteGithubUserToken(db, wsId, userId);
    expect(await getGithubConnection(db, wsId, userId)).toBeNull();
    const rows = await owner`select id from github_user_tokens
      where workspace_id = ${wsId} and user_id = ${userId}`;
    expect(rows).toHaveLength(0);
  });

  it("hides one member's token row from another member of the same workspace", async () => {
    // The policy gates on the owning user, not just workspace membership, and
    // this is why. `infra/rls-role.sql` grants specboards_app DML on future
    // tables, so this table is reachable through the RLS connection as soon as
    // it exists; a membership-only policy would hand a colleague someone else's
    // credential row the first time any query touched it.
    await storeGithubUserToken(db, wsId, userId, "janedoe", token());
    await owner`insert into members (workspace_id, user_id, role) values
      (${wsId}, ${userId}, 'owner'), (${wsId}, ${colleagueId}, 'member')
      on conflict do nothing`;

    const app = postgres(appUrl(), { prepare: false, max: 1 });
    // In a transaction because `set_config(..., true)` is transaction-local,
    // which is how the app sets the acting user in the first place.
    const readAs = (actor: string) =>
      app.begin(async (sql) => {
        await sql`select set_config('app.user_id', ${actor}, true)`;
        return sql`select user_id from github_user_tokens where workspace_id = ${wsId}`;
      });

    try {
      expect(await readAs(colleagueId)).toHaveLength(0);
      // The owner of the row still reaches it, so the policy is not simply
      // closed to everyone, which would pass the assertion above for a bad
      // reason.
      expect(await readAs(userId)).toHaveLength(1);
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it("drops a connection when the workspace goes", async () => {
    await storeGithubUserToken(db, otherWsId, userId, "janedoe", token());
    await owner`delete from workspaces where id = ${otherWsId}`;
    const rows = await owner`select id from github_user_tokens
      where workspace_id = ${otherWsId}`;
    // Cascade, so a deleted tenant cannot leave live repo credentials behind.
    expect(rows).toHaveLength(0);
  });
});
