import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createDb } from "@specboards/db";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PROPOSAL_CLOSE, PROPOSAL_OPEN } from "@/lib/ai/proposals";
import { saveModelProvider } from "@/lib/model-provider-service";
import { saveUsageLimits } from "@/lib/usage-service";
import { runSkillOnItem } from "./skill-run";
import { RunInputError } from "./types";

/**
 * A skill running with nobody watching.
 *
 * ── Why a real endpoint rather than a stub of the provider ──────────────────
 * The claim under test is that the run path goes through the same choke point
 * an interactive turn does, so spend caps and the usage ledger apply to it
 * without anybody remembering to apply them. Stubbing
 * `completeWithWorkspaceModel` would delete exactly that claim and leave a test
 * that proves the code calls the function it obviously calls.
 *
 * So the workspace is pointed at a local HTTP server speaking enough of the
 * OpenAI shape to answer, the same technique `openai-compatible.test.ts` uses.
 * It runs on loopback, which the egress policy refuses by default, so the test
 * sets `SPECBOARDS_MODEL_ALLOW_PRIVATE=1`: that is the same opt-in an on-prem
 * deployment makes, which means this exercises that path too.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Set at module scope, matching `assistant.int.test.ts`. The provider's API key
// is encrypted with this on the way in, so a save fails without it.
process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";
// The stub endpoint is on loopback, which the egress policy refuses unless a
// deployment opts in. Needing this is the same opt-in an on-prem install makes,
// so the test exercises that path too.
process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
delete process.env.SPECBOARDS_MULTI_TENANT;

const sfx = randomUUID().slice(0, 8);
const ws = randomUUID();
const product = randomUUID();
const owner = randomUUID();
const agent = randomUUID();
const scope = { userId: owner, workspaceId: ws };

/** What the fake endpoint should answer next. */
let reply: { status: number; body: unknown } = { status: 200, body: null };
let calls = 0;

function completion(text: string) {
  return {
    id: "cmpl-1",
    model: "test-model",
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe.skipIf(!DB_URL)("running a skill as a run", () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof createDb>;
  let server: Server;
  let baseUrl: string;
  let specId: string;
  let featureId: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      calls += 1;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body ?? completion("nothing to say")));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    sql = postgres(DB_URL!, { prepare: false, max: 3 });
    db = createDb(DB_URL!);

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Skill runs', ${"skillrun-" + sfx})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Owner', ${`owner-${sfx}@run.test`}),
      (${agent}, 'Bot', ${`bot-${sfx}@run.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner'), (${ws}, ${agent}, 'service')`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'epic', 'Epics', 0, false),
             (${ws}, 'story', 'Stories', 1, true)`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${owner}, ${agent})`;
    await sql.end({ timeout: 5 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    calls = 0;
    reply = { status: 200, body: null };
    await sql`delete from proposals where workspace_id = ${ws}`;
    await sql`delete from agent_runs where workspace_id = ${ws}`;
    await sql`delete from features where workspace_id = ${ws}`;
    await sql`delete from model_usage_events where workspace_id = ${ws}`;
    await sql`delete from model_providers where workspace_id = ${ws}`;
    await sql`delete from workspace_usage_limits where workspace_id = ${ws}`.catch(
      () => {},
    );

    featureId = randomUUID();
    specId = randomUUID();
    // A DB-native card, so the body is `details`. A spec-backed item would
    // carry its body in `spec_index.content` instead, and the run path reads
    // whichever the store resolves rather than either column directly.
    await sql`insert into features
      (id, workspace_id, product_id, spec_id, level, title, status, details)
      values (${featureId}, ${ws}, ${product}, ${specId}, 'story',
              'Checkout flow', 'backlog', 'A short description.')`;

    await saveModelProvider(db, scope, {
      baseUrl,
      model: "test-model",
      apiKey: "sk-test",
    });
  });

  const run = (over: Record<string, unknown> = {}) =>
    runSkillOnItem(db, scope, {
      specId,
      skillKey: "draft",
      agentId: null,
      trigger: "manual",
      ...over,
    });

  const runRow = async (id: string) =>
    (
      await sql<
        { status: string; error: string | null; summary: string | null }[]
      >`select status, error, summary from agent_runs where id = ${id}`
    )[0]!;

  it("refuses a skill the workspace does not offer, without opening a run", async () => {
    await expect(run({ skillKey: "no-such-skill" })).rejects.toBeInstanceOf(
      RunInputError,
    );
    const [runs] = await sql<{ n: string }[]>`
      select count(*) as n from agent_runs where workspace_id = ${ws}`;
    // A run opened and abandoned would sit on the item's card forever, and the
    // reconciler would have to guess what happened to it.
    expect(Number(runs!.n)).toBe(0);
  });

  it("refuses a release skill pointed at an item", async () => {
    // Not tidiness: a release-notes skill on a work item does not fail, it
    // produces a confident answer about the wrong thing.
    await expect(run({ skillKey: "release-notes" })).rejects.toThrow(
      /release skill/i,
    );
    expect(calls, "the model must not be called at all").toBe(0);
  });

  it("writes the proposal it drafted, and finishes the run", async () => {
    reply = {
      status: 200,
      body: completion(
        `Here is a tighter description.\n${PROPOSAL_OPEN}\nA much better description.\n${PROPOSAL_CLOSE}`,
      ),
    };

    const out = await run();
    expect(out.status).toBe("succeeded");
    expect(out.proposalId).not.toBeNull();

    const [proposal] = await sql<
      {
        origin: string;
        status: string;
        kind: string;
        target_id: string;
        run_id: string | null;
        payload: { body: string };
      }[]
    >`select origin, status, kind, target_id, run_id, payload
        from proposals where workspace_id = ${ws}`;
    // `origin = 'run'` is what puts it in the review inbox rather than in a
    // conversation thread, and what makes the watchers notification fire.
    expect(proposal!.origin).toBe("run");
    expect(proposal!.status).toBe("open");
    expect(proposal!.target_id).toBe(featureId);
    expect(proposal!.run_id).toBe(out.runId);
    expect(proposal!.payload.body).toBe("A much better description.");

    const row = await runRow(out.runId);
    expect(row.status).toBe("succeeded");
    expect(row.summary).toMatch(/proposed a change/);
  });

  it("finishes cleanly when the model had nothing to propose", async () => {
    reply = { status: 200, body: completion("This looks fine to me already.") };

    const out = await run();
    expect(out.status).toBe("succeeded");
    expect(out.proposalId).toBeNull();

    const row = await runRow(out.runId);
    // "Nothing to propose" is a result, not a failure. Recording it as one
    // would teach people to ignore failed runs.
    expect(row.status).toBe("succeeded");
    expect(row.summary).toMatch(/nothing to propose/);
  });

  it("keeps the prose, so nothing-to-propose can be told from said-nothing", async () => {
    reply = {
      status: 200,
      body: completion("The acceptance criteria already cover the failure path."),
    };
    const out = await run();
    const [row] = await sql<{ trace: { detail?: string }[] }[]>`
      select trace from agent_runs where id = ${out.runId}`;
    expect(JSON.stringify(row!.trace)).toContain("acceptance criteria");
  });

  it("withholds a proposal drafted from a description too long to send whole", async () => {
    // The sharpest failure mode on this path. A whole-body replacement drafted
    // from a shortened description deletes everything past the cut, and an
    // unattended run has nobody sitting there to notice. `canPropose` is
    // already false in that case; this pins that the run path honours it
    // rather than writing the proposal anyway.
    const { BODY_CHAR_LIMIT } = await import("@/lib/ai/item-context");
    await sql`update features set details = ${"x".repeat(BODY_CHAR_LIMIT + 1)}
              where id = ${featureId}`;
    reply = {
      status: 200,
      body: completion(
        `Tidied.\n${PROPOSAL_OPEN}\nA replacement body.\n${PROPOSAL_CLOSE}`,
      ),
    };

    const out = await run();
    expect(out.status).toBe("succeeded");
    expect(out.proposalId).toBeNull();
    const [proposals] = await sql<{ n: string }[]>`
      select count(*) as n from proposals where workspace_id = ${ws}`;
    expect(Number(proposals!.n)).toBe(0);
  });

  it("records the spend against the ledger, under its own feature", async () => {
    reply = { status: 200, body: completion("Fine.") };
    await run();

    const [usage] = await sql<
      { feature: string; prompt_tokens: number; outcome: string }[]
    >`select feature, prompt_tokens, outcome from model_usage_events
        where workspace_id = ${ws}`;
    // Its own label rather than assistant_turn: an owner asking "what is
    // spending this while nobody is looking" cannot act on a number that
    // buries unattended work inside the interactive total.
    expect(usage!.feature).toBe("skill_run");
    expect(usage!.prompt_tokens).toBe(100);
    expect(usage!.outcome).toBe("ok");
  });

  it("fails the run rather than throwing when the endpoint refuses", async () => {
    reply = { status: 401, body: { error: { message: "bad key" } } };

    const out = await run();
    expect(out.status).toBe("failed");
    expect(out.error).toBeTruthy();

    const row = await runRow(out.runId);
    // The run must reach a terminal state. One stuck at `running` is exactly
    // what the review queue's reconciler exists to clean up, and this path
    // should not be manufacturing more of them.
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
  });

  it("fails the run, and calls no model, when the workspace is at its cap", async () => {
    await saveUsageLimits(db, scope, { monthlyTokenCap: 1 });
    await sql`insert into model_usage_events
      (workspace_id, user_id, feature, model, prompt_tokens, completion_tokens, outcome)
      values (${ws}, ${owner}, 'assistant_turn', 'test-model', 5000, 5000, 'ok')`;
    calls = 0;

    const out = await run();
    expect(out.status).toBe("failed");
    expect(calls, "a capped workspace must not reach the endpoint").toBe(0);
    expect(out.error).toMatch(/cap/i);
  });

  it("fails the run when no model is connected, and says how to fix it", async () => {
    await sql`delete from model_providers where workspace_id = ${ws}`;

    const out = await run();
    expect(out.status).toBe("failed");
    // "No model connected" is setup nobody has done, not a fault to go hunting
    // for, so the message says where to go rather than what broke.
    expect(out.error).toMatch(/Settings > Agents/);
  });

  it("joins the run already open on the item rather than opening a second", async () => {
    // Two schedules pointing at the same skill and item must collapse to one
    // active run, which `agent_runs_one_active_uq` and openRun already give.
    reply = { status: 200, body: completion("Fine.") };
    const first = await run({ agentId: agent });
    await sql`update agent_runs set status = 'running', finished_at = null
              where id = ${first.runId}`;
    const second = await run({ agentId: agent });

    expect(second.runId).toBe(first.runId);
    const [runs] = await sql<{ n: string }[]>`
      select count(*) as n from agent_runs where workspace_id = ${ws}`;
    expect(Number(runs!.n)).toBe(1);
  });
});
