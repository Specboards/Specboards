import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDb } from "@specboards/db";

import {
  bootstrapSecretMatches,
  ensureBootstrapSecret,
} from "@/lib/bootstrap";

/**
 * "Has this deployment got any accounts" is stubbed to no.
 *
 * The integration database is shared and has users in it from every other
 * suite, so the real predicate answers yes and the gate is inert. Stubbing it
 * is the honest seam: what this file is for is the storage half (a row really
 * written, only a hash in it, one winner, tenant role locked out), and that is
 * all exercised for real. The predicate itself is covered in
 * `bootstrap.test.ts`, and it is one `select 1 ... limit 1` whose behaviour
 * does not depend on this table at all.
 */
vi.mock("@/lib/first-run", () => ({
  hasAnyUser: async () => false,
  resetFirstRunCache: () => {},
}));

/**
 * The first-run gate against a real database.
 *
 * The unit tests cover the env paths and the fail-closed cases with the
 * database mocked. What needs Postgres is the generated-token half: that the
 * row is really written, that only a hash reaches the table, that a second
 * instance cannot write a competing one, and that the tenant role cannot read
 * any of it.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "bootstrap_int_app";
const APP_PASSWORD = "bootstrap-int-only-not-a-real-secret";

const savedEnv = {
  token: process.env.SPECBOARDS_BOOTSTRAP_TOKEN,
  code: process.env.SPECBOARDS_SIGNUP_CODE,
};

describe.skipIf(!OWNER_URL)("first-run token storage", () => {
  let owner: postgres.Sql;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);
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
    await owner`delete from bootstrap_secret`;
    await owner.end({ timeout: 5 });
  });

  afterEach(() => {
    for (const [k, v] of [
      ["SPECBOARDS_BOOTSTRAP_TOKEN", savedEnv.token],
      ["SPECBOARDS_SIGNUP_CODE", savedEnv.code],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** An unclaimed instance: no accounts, no token row, nothing configured. */
  async function unclaimed() {
    delete process.env.SPECBOARDS_BOOTSTRAP_TOKEN;
    delete process.env.SPECBOARDS_SIGNUP_CODE;
    await owner`delete from bootstrap_secret`;
  }

  it("stores a hash and never the token", async () => {
    await unclaimed();
    const result = await ensureBootstrapSecret(db);
    expect(result.state).toBe("generated");
    const token = (result as { token: string }).token;

    const [row] = await owner`select token_hash from bootstrap_secret`;
    expect(row!.token_hash).toBe(
      createHash("sha256").update(token, "utf8").digest("hex"),
    );
    // The whole bargain: a database dump does not hand somebody an unclaimed
    // instance.
    const dump = await owner`select * from bootstrap_secret`;
    expect(JSON.stringify(dump)).not.toContain(token);
  });

  it("admits the generated token and refuses anything else", async () => {
    await unclaimed();
    const result = await ensureBootstrapSecret(db);
    const token = (result as { token: string }).token;

    expect(await bootstrapSecretMatches(db, token)).toBe(true);
    expect(await bootstrapSecretMatches(db, `${token}x`)).toBe(false);
    expect(await bootstrapSecretMatches(db, token.slice(0, -1))).toBe(false);
    expect(await bootstrapSecretMatches(db, "")).toBe(false);
  });

  it("admits nobody when no token has been generated", async () => {
    // Fail closed. An instance with no secret is unclaimable, not open.
    await unclaimed();
    expect(await bootstrapSecretMatches(db, "guess")).toBe(false);
  });

  it("lets only one instance win the race to generate", async () => {
    await unclaimed();
    const [first, second] = await Promise.all([
      ensureBootstrapSecret(db),
      ensureBootstrapSecret(db),
    ]);
    const states = [first.state, second.state].sort();
    expect(states).toEqual(["already-generated", "generated"]);

    const rows = await owner`select count(*)::int as n from bootstrap_secret`;
    expect(rows[0]!.n).toBe(1);

    // And the one that won is the one whose token actually opens the door.
    const winner = (first.state === "generated" ? first : second) as {
      token: string;
    };
    expect(await bootstrapSecretMatches(db, winner.token)).toBe(true);
  });

  it("holds at most one row", async () => {
    await unclaimed();
    await owner`insert into bootstrap_secret (token_hash) values ('a')`;
    await expect(
      owner`insert into bootstrap_secret (token_hash) values ('b')`,
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("keeps the tenant role out of it", async () => {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const [row] = await owner`
        select has_table_privilege('specboards_app', 'bootstrap_secret', ${priv}) as ok`;
      expect(row!.ok, `${priv} should be revoked`).toBe(false);
    }

    const app = postgres(appUrlFrom(OWNER_URL!), { prepare: false, max: 1 });
    try {
      await expect(
        app`select 1 from bootstrap_secret limit 1`,
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.end({ timeout: 5 });
    }
  });
});

function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}
