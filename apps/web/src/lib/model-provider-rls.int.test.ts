import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The one case that decides whether moving onto the RLS-enforced connection was
 * done correctly: can an ORDINARY MEMBER's assistant call still reach the
 * workspace's model with the workspace's key?
 *
 * It is the case that breaks if the move is done naively.
 * `model_provider_credentials_admin` (0067) is org-admin only, including for
 * SELECT, and the credential is read inside a member's request. A plain query
 * returns no row there, and because `resolveConfig` reads
 * `cred ? decrypt(...) : null`, the key becomes null rather than an error: the
 * call goes out unauthenticated and the endpoint rejects it, with nothing in the
 * response saying why. `owner-connection-rls.int.test.ts` pins the underlying
 * policy behaviour; this pins the behaviour of the product built on it.
 *
 * So the assertion is deliberately made at the far end: a stub endpoint records
 * the Authorization header it actually received. Anything that mocks nearer than
 * the wire could pass while the real request went out bare.
 *
 * Runs against DATABASE_URL, provisioning its own non-owner login rather than
 * asking for one, so it cannot quietly skip in CI. On an owner connection every
 * case here would pass without a policy being consulted, which is the failure
 * this arrangement avoids.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";
process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
delete process.env.SPECBOARDS_MULTI_TENANT;

const suffix = randomUUID().slice(0, 8);
const ws = randomUUID();
const ownerId = randomUUID();
const memberId = randomUUID();

const asOwner = { userId: ownerId, workspaceId: ws };
const asMember = { userId: memberId, workspaceId: ws };

const API_KEY = "sk-members-must-be-able-to-use-this";

/**
 * A non-owner login derived from the owner URL, provisioned the way
 * `infra/rls-role.sql` does.
 *
 * Deliberately NOT read from `DATABASE_URL_APP`: CI does not set it, so a suite
 * that required it would skip there and this guard would never actually run.
 * Same approach, and the same role, as `store/rls-isolation.int.test.ts`.
 */
const APP_ROLE = "rls_int_app";
const APP_PASSWORD = "rls-int-only-not-a-real-secret";

function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

async function provisionAppRole(owner: postgres.Sql): Promise<void> {
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
}

describe.skipIf(!DB_URL)("a member's model call over the app role", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let svc: typeof import("./model-provider-service");
  let server: Server;
  let endpoint: string;
  let seenAuth: string[] = [];

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    svc = await import("./model-provider-service");

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seenAuth.push(req.headers.authorization ?? "(none)");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "stub-model-v1",
            choices: [{ message: { content: "answered" } }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await provisionAppRole(sql);
    db = createDb(appUrlFrom(DB_URL!));

    await sql`insert into workspaces (id, name, slug) values (${ws}, 'Provider RLS', ${`prls-${suffix}`})`;
    await sql`insert into users (id, name, email) values
      (${ownerId}, 'Ada', ${`ada-${suffix}@prls.test`}),
      (${memberId}, 'Mo', ${`mo-${suffix}@prls.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${ownerId}, 'owner'),
      (${ws}, ${memberId}, 'member')`;

    // Saved by the admin, over the same enforced connection the app uses.
    await svc.saveModelProvider(db, asOwner, {
      baseUrl: endpoint,
      model: "stub-model-v1",
      apiKey: API_KEY,
    });
  });

  afterAll(async () => {
    await sql`delete from model_usage_events where workspace_id = ${ws}`;
    await sql`delete from model_providers where workspace_id = ${ws}`;
    await sql`delete from model_provider_credentials where workspace_id = ${ws}`;
    await sql`delete from members where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in ${sql([ownerId, memberId])}`;
    await sql.end({ timeout: 5 });
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE;
  });

  it("sends the workspace's key when an ordinary member asks", async () => {
    seenAuth = [];
    const outcome = await svc.completeWithWorkspaceModel(
      db,
      ws,
      { messages: [{ role: "user", content: "hello" }], maxTokens: 32 },
      { userId: memberId, feature: "assistant_turn" },
    );

    expect(outcome.ok).toBe(true);
    // The whole point. Without the SECURITY DEFINER resolver this is "(none)".
    expect(seenAuth).toEqual([`Bearer ${API_KEY}`]);
  });

  it("still works for an admin, so the resolver did not trade one for the other", async () => {
    seenAuth = [];
    const outcome = await svc.completeWithWorkspaceModel(
      db,
      ws,
      { messages: [{ role: "user", content: "hello" }], maxTokens: 32 },
      { userId: ownerId, feature: "assistant_turn" },
    );
    expect(outcome.ok).toBe(true);
    expect(seenAuth).toEqual([`Bearer ${API_KEY}`]);
  });

  it("refuses somebody who is not a member of the workspace at all", async () => {
    // The resolver checks membership itself rather than trusting its arguments,
    // so knowing two uuids is not enough. Asserted through the service, because
    // that is the shape an attacker would have.
    seenAuth = [];
    const stranger = randomUUID();
    const outcome = await svc.completeWithWorkspaceModel(
      db,
      ws,
      { messages: [{ role: "user", content: "hello" }], maxTokens: 32 },
      { userId: stranger, feature: "assistant_turn" },
    );

    // `model_providers_read` hides the provider row from a non-member, so there
    // is no connection to resolve and nothing is sent anywhere. That is the
    // right answer and a stronger one than "the key was withheld": the request
    // never left the process.
    expect(outcome.ok).toBe(false);
    expect(seenAuth).toEqual([]);
  });

  it("does not let a member read the credential by ordinary means", async () => {
    // The line the resolver draws: a member may USE the key, and may not READ
    // it. `getModelProvider` returns the hint through the admin-only policy, so
    // a member sees the connection without its credential hint.
    const asAdmin = await svc.getModelProvider(db, asOwner);
    expect(asAdmin?.credentialHint).toBeTruthy();

    const asPlainMember = await svc.getModelProvider(db, asMember);
    expect(asPlainMember).not.toBeNull();
    expect(asPlainMember?.credentialHint).toBeNull();
  });
});
