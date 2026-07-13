import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Database } from "@specboard/db";

import {
  boundWorkspaceSlug,
  consentWorkspaceOptions,
  recordMcpWorkspaceBinding,
} from "./workspace-binding";

/**
 * Integration coverage for the MCP consent-screen workspace binding: the row
 * that lets the `/api/mcp` resolver scope a connection without an `x-org-slug`
 * header. Proves the upsert overwrites (one workspace per user+client, not a
 * pile of rows) and that a slug only comes back for a real membership.
 *
 * Needs a migrated Postgres at DATABASE_URL (CI's service container, or a local
 * disposable postgres:16). Skips itself when no database is configured.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const suffix = randomUUID().slice(0, 8);
const ws = { a: randomUUID(), b: randomUUID() };
const slug = { a: `mcpbind-a-${suffix}`, b: `mcpbind-b-${suffix}` };
const userId = randomUUID();
const clientId = `mcpbind-client-${suffix}`;

describe.skipIf(!OWNER_URL)("MCP workspace binding", () => {
  let owner: postgres.Sql;
  let db: Database;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);

    await owner`insert into users (id, name, email) values
      (${userId}, 'Binder', ${`binder-${suffix}@mcp.test`})`;
    // Workspace B first alphabetically ("Alpha") to check ordering by name.
    await owner`insert into workspaces (id, name, slug) values
      (${ws.a}, 'Beta', ${slug.a}),
      (${ws.b}, 'Alpha', ${slug.b})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws.a}, ${userId}, 'admin'),
      (${ws.b}, ${userId}, 'admin')`;
    await owner`insert into oauth_applications (client_id, redirect_urls, type) values
      (${clientId}, 'http://localhost/callback', 'public')`;
  });

  afterAll(async () => {
    // Bindings cascade from the user/client delete, but be explicit.
    await owner`delete from mcp_workspace_bindings where user_id = ${userId}`;
    await owner`delete from oauth_applications where client_id = ${clientId}`;
    await owner`delete from members where user_id = ${userId}`;
    await owner`delete from workspaces where id in (${ws.a}, ${ws.b})`;
    await owner`delete from users where id = ${userId}`;
    await owner.end();
  });

  it("lists the caller's workspaces for the picker, ordered by name", async () => {
    const options = await consentWorkspaceOptions(db, userId);
    const mine = options.filter((o) => o.id === ws.a || o.id === ws.b);
    expect(mine.map((o) => o.name)).toEqual(["Alpha", "Beta"]);
  });

  it("returns no bound slug before a choice is recorded", async () => {
    expect(await boundWorkspaceSlug(db, userId, clientId)).toBeNull();
  });

  it("records the chosen workspace and reads it back as a slug", async () => {
    await recordMcpWorkspaceBinding(db, { userId, clientId, workspaceId: ws.a });
    expect(await boundWorkspaceSlug(db, userId, clientId)).toBe(slug.a);
  });

  it("upserts on (user, client) so re-picking overwrites, not duplicates", async () => {
    await recordMcpWorkspaceBinding(db, { userId, clientId, workspaceId: ws.b });
    expect(await boundWorkspaceSlug(db, userId, clientId)).toBe(slug.b);

    const rows = await owner`
      select count(*)::int as n from mcp_workspace_bindings
      where user_id = ${userId} and client_id = ${clientId}`;
    expect(rows[0]!.n).toBe(1);
  });
});
