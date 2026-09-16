import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * A connected agent reading the workspace's own procedures.
 *
 * Driven through the whole RPC path with a real API key rather than by calling
 * the tool's `run` directly, for the reason `scope-enforcement.int.test.ts`
 * gives: a test that builds its own context verifies the tool and not the
 * plumbing that fills it. Here the plumbing is most of the claim. The skills
 * are read over the RLS connection as the key's owner, so "an agent sees this
 * team's skills" and "an agent sees a skill" are different assertions and only
 * the real path can tell them apart.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const sfx = randomUUID().slice(0, 8);
const workspace = { id: randomUUID(), slug: `skills-${sfx}` };
const userId = randomUUID();

interface ListedSkill {
  key: string;
  name: string;
  description: string;
  instructions: string;
  surface: string;
  surfaceLabel: string;
  origin: "built-in" | "customised" | "workspace";
}

describe.skipIf(!DB_URL)("list_skills over MCP", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let fullKey: string;
  let readKey: string;
  let itemsOnlyKey: string;
  let resolveMcpAuth: typeof import("./rpc").resolveMcpAuth;
  let handleMcpMessage: typeof import("./rpc").handleMcpMessage;

  function request(key: string): Request {
    return new Request("https://app.example.test/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-org-slug": workspace.slug },
    });
  }

  /** The raw text an agent would see. */
  async function callRaw(
    key: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const auth = await resolveMcpAuth(request(key));
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_skills", arguments: args },
      },
      auth,
    );
    const result = res?.result as { content?: { text: string }[] } | undefined;
    return result?.content?.[0]?.text ?? "";
  }

  /** The parsed answer, for the ordinary success cases. */
  async function call(
    key: string,
    args: Record<string, unknown> = {},
  ): Promise<{ skills: ListedSkill[]; note: string }> {
    return JSON.parse(await callRaw(key, args));
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    ({ resolveMcpAuth, handleMcpMessage } = await import("./rpc"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'Skills', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${userId}, 'Agent Owner', ${`agent-${sfx}@skills.test`})`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${userId}, 'owner')`;

    const { createApiKey } = await import("@/lib/api-keys");
    fullKey = (await createApiKey(db, userId, "full", null, [])).key;
    readKey = (
      await createApiKey(db, userId, "reader", null, ["assistant-skills:read"])
    ).key;
    // Deliberately holds a different resource. Reading the procedures must not
    // come free with permission to read the board.
    itemsOnlyKey = (await createApiKey(db, userId, "items", null, ["features:read"]))
      .key;
  });

  afterAll(async () => {
    await sql`delete from api_keys where user_id = ${userId}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`delete from workspace_assistant_skills where workspace_id = ${workspace.id}`;
  });

  it("returns the built-ins to a workspace that has stored nothing", async () => {
    const { skills } = await call(fullKey);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.origin === "built-in")).toBe(true);
    // A fresh self-host with an empty database has these, because they are
    // constants in code rather than seeded rows.
    expect(skills.map((s) => s.key)).toContain("grill");
  });

  it("sends each skill's instructions in full, not just its name", async () => {
    // The whole point of the tool. A menu of names would let an agent pick a
    // button it cannot press and tell it nothing about how to do the work.
    const { skills } = await call(fullKey);
    const grill = skills.find((s) => s.key === "grill");
    expect(grill?.instructions.length ?? 0).toBeGreaterThan(200);
    expect(grill?.instructions).toContain("interrogate this definition");
  });

  it("hands over a rewritten built-in rather than ours, and says it was rewritten", async () => {
    await sql`insert into workspace_assistant_skills
      (workspace_id, key, name, description, instructions, surface, enabled, position)
      values (${workspace.id}, 'grill', 'Interrogate', 'Our way',
              'Ask about regulated data first, every time.', 'item', true, 0)`;

    const { skills } = await call(fullKey);
    const grill = skills.find((s) => s.key === "grill");
    expect(grill?.instructions).toBe(
      "Ask about regulated data first, every time.",
    );
    expect(grill?.name).toBe("Interrogate");
    // An agent that cannot tell a local convention from our default cannot
    // report whose procedure it followed.
    expect(grill?.origin).toBe("customised");
  });

  it("marks a skill the team invented as theirs", async () => {
    await sql`insert into workspace_assistant_skills
      (workspace_id, key, name, description, instructions, surface, enabled, position)
      values (${workspace.id}, 'house-style', 'House style', 'Ours alone',
              'Every spec opens with the customer problem.', 'item', true, 0)`;

    const { skills } = await call(fullKey);
    expect(skills.find((s) => s.key === "house-style")?.origin).toBe("workspace");
  });

  it("does not list a skill the team switched off", async () => {
    // Off means the team decided their assistant should not do that. An agent
    // reading the row could only use it to follow a procedure they withdrew.
    await sql`insert into workspace_assistant_skills
      (workspace_id, key, name, description, instructions, surface, enabled, position)
      values (${workspace.id}, 'grill', null, null, null, 'item', false, 0)`;

    const { skills } = await call(fullKey);
    expect(skills.map((s) => s.key)).not.toContain("grill");
  });

  it("filters to one surface when asked", async () => {
    const { skills } = await call(fullKey, { surface: "release" });
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.surface === "release")).toBe(true);
    expect(skills.map((s) => s.key)).not.toContain("grill");
  });

  it("says why the list is empty rather than leaving it to be guessed", async () => {
    // An empty array reads as "this team has no conventions", which is a
    // different and more discouraging claim than "nothing matched the filter".
    for (const key of [
      "grill",
      "gaps",
      "draft",
      "release-notes",
      "tighten",
    ]) {
      await sql`insert into workspace_assistant_skills
        (workspace_id, key, name, description, instructions, surface, enabled, position)
        values (${workspace.id}, ${key}, null, null, null, 'item', false, 0)`;
    }
    const all = await call(fullKey);
    expect(all.skills).toEqual([]);
    expect(all.note).toMatch(/no skills switched on/i);
  });

  it("is reachable with assistant-skills:read alone", async () => {
    const text = await callRaw(readKey);
    expect(text).not.toContain("lacks the");
    expect(JSON.parse(text).skills.length).toBeGreaterThan(0);
  });

  it("is refused to a key that may read the board but not the procedures", async () => {
    // `assistant-skills` is its own resource for the same shape of reason
    // `assistant` is: the standing instructions every future answer is given
    // under are not part of reading the backlog.
    const text = await callRaw(itemsOnlyKey);
    expect(text).toContain("lacks the");
    expect(text).toContain("assistant-skills:read");
  });

  it("is advertised to a key that holds the scope, and hidden from one that does not", async () => {
    for (const [key, visible] of [
      [readKey, true],
      [itemsOnlyKey, false],
    ] as const) {
      const auth = await resolveMcpAuth(request(key));
      const res = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        auth,
      );
      const names = ((res?.result as { tools: { name: string }[] }).tools ?? []).map(
        (t) => t.name,
      );
      expect(names.includes("list_skills"), `visible=${visible}`).toBe(visible);
    }
  });

  it("never mutates: it is a read tool and the registry says so", async () => {
    const { TOOLS } = await import("./tools");
    const tool = TOOLS.find((t) => t.name === "list_skills");
    expect(tool?.write).toBe(false);
    expect(tool?.destructive).toBeFalsy();
    expect(tool?.commits).toBeFalsy();
  });
});
