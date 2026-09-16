import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createDb } from "@specboards/db";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { saveModelProvider } from "@/lib/model-provider-service";
import { runSkillOnItem } from "@/lib/runs/skill-run";

/**
 * The architecture review, end to end against a real database.
 *
 * Two claims, and the second is the one that matters:
 *
 * 1. A team's architecture pages actually reach the model. Asserted against the
 *    request body the stub endpoint received, not against an intermediate
 *    structure, because every layer between here and there is a place the text
 *    could quietly stop travelling.
 *
 * 2. **A review with nothing to review against refuses, and spends nothing.**
 *    This is the failure the whole skill is written around. A model given an
 *    item and no architecture will produce a competent-sounding review of the
 *    item, and that answer is indistinguishable from a check that ran and found
 *    no problems. So "did the endpoint get called at all" is the assertion, and
 *    a refusal that still spent a token would be a bug even if the wording was
 *    right.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";
// The stub endpoint is on loopback, which the egress policy refuses unless a
// deployment opts in, the same opt-in an on-prem install makes.
process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
delete process.env.SPECBOARDS_MULTI_TENANT;

const sfx = randomUUID().slice(0, 8);
const ws = randomUUID();
const product = randomUUID();
const owner = randomUUID();
const scope = { userId: owner, workspaceId: ws };

let calls = 0;
/** The last prompt the endpoint was sent, which is what "sent" has to mean. */
let lastPrompt = "";

describe.skipIf(!DB_URL)("the architecture review", () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof createDb>;
  let server: Server;
  let baseUrl: string;
  let specId: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls += 1;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as {
            messages?: { role: string; content: string }[];
          };
          lastPrompt =
            parsed.messages?.find((m) => m.role === "system")?.content ?? "";
        } catch {
          lastPrompt = "";
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "cmpl-1",
            model: "test-model",
            choices: [
              { message: { role: "assistant", content: "Nothing to flag." } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    sql = postgres(DB_URL!, { prepare: false, max: 3 });
    db = createDb(DB_URL!);

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Architecture', ${"arch-" + sfx})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Owner', ${`owner-${sfx}@arch.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner')`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'epic', 'Epics', 0, false),
             (${ws}, 'story', 'Stories', 1, true)`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id = ${owner}`;
    await sql.end({ timeout: 5 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    calls = 0;
    lastPrompt = "";
    await sql`delete from agent_runs where workspace_id = ${ws}`;
    await sql`delete from proposals where workspace_id = ${ws}`;
    await sql`delete from doc_pages where workspace_id = ${ws}`;
    await sql`delete from doc_spaces where workspace_id = ${ws}`;
    await sql`delete from features where workspace_id = ${ws}`;
    await sql`delete from model_providers where workspace_id = ${ws}`;

    specId = randomUUID();
    await sql`insert into features
      (id, workspace_id, product_id, spec_id, level, title, status, details)
      values (${randomUUID()}, ${ws}, ${product}, ${specId}, 'story',
              'Retry failed payments', 'backlog',
              'Payments that fail once should be retried.')`;

    await saveModelProvider(db, scope, {
      baseUrl,
      model: "test-model",
      apiKey: "sk-test",
    });
  });

  const review = () =>
    runSkillOnItem(db, scope, {
      specId,
      skillKey: "architecture-impact",
      agentId: null,
      trigger: "manual",
    });

  async function addPage(
    title: string,
    content: string,
    parentId: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await sql`insert into doc_pages
      (id, workspace_id, product_id, area, parent_id, kind, title, content, position)
      values (${id}, ${ws}, ${product}, 'architecture', ${parentId}, 'page',
              ${title}, ${content}, 0)`;
    return id;
  }

  it("sends the architecture pages to the model", async () => {
    await addPage("Payments", "Payments are never retried automatically.");

    const outcome = await review();

    expect(outcome.status).toBe("succeeded");
    expect(lastPrompt).toContain("Payments are never retried automatically.");
    // Named in the outline as well as quoted, which is what lets the model say
    // which page an objection came from.
    expect(lastPrompt).toContain("Payments");
  });

  it("names a page by its folder path, the way a reader would find it", async () => {
    const folder = randomUUID();
    await sql`insert into doc_pages
      (id, workspace_id, product_id, area, parent_id, kind, title, content, position)
      values (${folder}, ${ws}, ${product}, 'architecture', null, 'folder',
              'Events', '', 0)`;
    await addPage("Bus", "Services talk over the event bus.", folder);

    await review();

    expect(lastPrompt).toContain("Events/Bus");
  });

  it("refuses without spending anything when there is no architecture area", async () => {
    // The whole point. A review that ran here would answer confidently about
    // the item alone, and read exactly like a check that passed.
    await expect(review()).rejects.toThrow(/no Architecture area/);
    expect(calls).toBe(0);
  });

  it("leaves no run behind when it refuses", async () => {
    // Refused before the run is opened, so there is no half-finished run for
    // the review queue's reconciler to clean up, and nothing on the board
    // claiming a review happened.
    await expect(review()).rejects.toThrow();
    const [counted] = await sql<{ n: string }[]>`
      select count(*)::text as n from agent_runs where workspace_id = ${ws}`;
    expect(Number(counted!.n)).toBe(0);
  });

  it("refuses an area whose pages live somewhere it cannot read", async () => {
    await sql`insert into doc_spaces
      (id, workspace_id, product_id, area, mode, external_url)
      values (${randomUUID()}, ${ws}, ${product}, 'architecture', 'external',
              'https://example.com/architecture')`;

    await expect(review()).rejects.toThrow(/links out/);
    expect(calls).toBe(0);
  });

  it("refuses an area that exists and is empty, and says so in those words", async () => {
    await sql`insert into doc_spaces (id, workspace_id, product_id, area, mode)
      values (${randomUUID()}, ${ws}, ${product}, 'architecture', 'local')`;

    await expect(review()).rejects.toThrow(/no pages yet/);
    expect(calls).toBe(0);
  });

  it("does not send the architecture area to a skill that did not ask", async () => {
    await addPage("Payments", "Payments are never retried automatically.");

    await runSkillOnItem(db, scope, {
      specId,
      skillKey: "gaps",
      agentId: null,
      trigger: "manual",
    });

    expect(calls).toBe(1);
    expect(lastPrompt).not.toContain("Payments are never retried automatically.");
  });
});
