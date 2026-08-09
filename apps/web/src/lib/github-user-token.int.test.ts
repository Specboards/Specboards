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
const suffix = randomUUID().slice(0, 8);

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
      (${userId}, 'Jane Doe', ${`jane-${suffix}@example.com`}, true)`;
  });

  afterAll(async () => {
    await owner`delete from users where id = ${userId}`;
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

  it("drops a connection when the workspace goes", async () => {
    await storeGithubUserToken(db, otherWsId, userId, "janedoe", token());
    await owner`delete from workspaces where id = ${otherWsId}`;
    const rows = await owner`select id from github_user_tokens
      where workspace_id = ${otherWsId}`;
    // Cascade, so a deleted tenant cannot leave live repo credentials behind.
    expect(rows).toHaveLength(0);
  });
});
