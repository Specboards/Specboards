import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createDb } from "@specboards/db";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PROPOSAL_CLOSE, PROPOSAL_OPEN } from "@/lib/ai/proposals";
import { saveModelProvider } from "@/lib/model-provider-service";
import { createSchedule } from "@/lib/schedules-service";
import { getWorkerDb } from "@/lib/db";
import { relayOutbox } from "@/lib/webhooks/relay";

import { sweepOnce } from "./dispatcher";
import { claimDueSchedules } from "./store";

/**
 * A schedule firing, end to end.
 *
 * Driven through `sweepOnce` and the real claim rather than by calling the
 * firing function directly, because most of what could go wrong is in the
 * claim: whether a schedule that is not due is left alone, whether a leased row
 * can be taken twice, whether the clock advances rather than firing forever.
 * None of that is visible from a unit test of the run.
 *
 * The model is a local HTTP server, as `skill-run.int.test.ts` explains at
 * length: stubbing the provider would delete the claim that a scheduled run
 * spends through the same choke point an interactive one does.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";
process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
delete process.env.SPECBOARDS_MULTI_TENANT;

const sfx = randomUUID().slice(0, 8);
const ws = randomUUID();
const product = randomUUID();
const owner = randomUUID();
const member = randomUUID();
const scope = { userId: owner, workspaceId: ws };

let reply: { status: number; body: unknown } = { status: 200, body: null };
let calls = 0;

function completion(text: string) {
  return {
    id: "cmpl-1",
    model: "test-model",
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const PROPOSING = () => ({
  status: 200,
  body: completion(`Tidied.\n${PROPOSAL_OPEN}\nA better body.\n${PROPOSAL_CLOSE}`),
});

describe.skipIf(!DB_URL)("the schedule dispatcher", () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof createDb>;
  let server: Server;
  let specId: string;
  let featureId: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls += 1;
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body ?? completion("nothing to say")));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    sql = postgres(DB_URL!, { prepare: false, max: 3 });
    db = createDb(DB_URL!);

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Schedules', ${"sched-" + sfx})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Owner', ${`owner-${sfx}@s.test`}),
      (${member}, 'Member', ${`member-${sfx}@s.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner'), (${ws}, ${member}, 'member')`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'epic', 'Epics', 0, false),
             (${ws}, 'story', 'Stories', 1, true)`;

    await saveModelProvider(db, scope, {
      baseUrl,
      model: "test-model",
      apiKey: "sk-test",
    });
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${owner}, ${member})`;
    await sql.end({ timeout: 5 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    calls = 0;
    reply = { status: 200, body: null };
    await sql`delete from agent_schedules where workspace_id = ${ws}`;
    await sql`delete from proposals where workspace_id = ${ws}`;
    await sql`delete from agent_runs where workspace_id = ${ws}`;
    await sql`delete from notifications where workspace_id = ${ws}`;
    await sql`delete from outbox_events where workspace_id = ${ws}`;
    await sql`delete from features where workspace_id = ${ws}`;

    featureId = randomUUID();
    specId = randomUUID();
    await sql`insert into features
      (id, workspace_id, product_id, spec_id, level, title, status, details)
      values (${featureId}, ${ws}, ${product}, ${specId}, 'story',
              'Checkout flow', 'backlog', 'A short description.')`;
  });

  /** A schedule, created through the service so validation is exercised too. */
  const make = (over: Record<string, unknown> = {}) =>
    createSchedule(db, scope, {
      name: "Weekly gaps",
      skillKey: "gaps",
      specId,
      cadence: { every: "week", weekday: 1, hour: 9, minute: 0 },
      timeZone: "Europe/London",
      ...over,
    });

  /** Make a schedule due, which the service will never do on creation. */
  const makeDue = async (id: string) => {
    await sql`update agent_schedules set next_run_at = now() - interval '1 minute'
              where id = ${id}`;
  };

  const row = async (id: string) =>
    (
      await sql<
        {
          next_run_at: Date;
          last_run_id: string | null;
          last_error: string | null;
          consecutive_failures: number;
          enabled: boolean;
        }[]
      >`select next_run_at, last_run_id, last_error, consecutive_failures, enabled
          from agent_schedules where id = ${id}`
    )[0]!;

  it("leaves a schedule that is not due alone", async () => {
    await make();
    await sweepOnce();
    expect(calls, "nothing should have reached the model").toBe(0);
    const [runs] = await sql<{ n: string }[]>`
      select count(*) as n from agent_runs where workspace_id = ${ws}`;
    expect(Number(runs!.n)).toBe(0);
  });

  it("fires a due schedule, opens a run, and proposes", async () => {
    reply = PROPOSING();
    const schedule = await make();
    await makeDue(schedule.id);
    await sweepOnce();

    const [run] = await sql<{ id: string; status: string; trigger: string }[]>`
      select id, status, trigger from agent_runs where workspace_id = ${ws}`;
    expect(run!.status).toBe("succeeded");
    // The run records how it was started, which is what tells a person reading
    // the item why something happened while they were not there.
    expect(run!.trigger).toBe("schedule");

    const [proposal] = await sql<{ origin: string; run_id: string }[]>`
      select origin, run_id from proposals where workspace_id = ${ws}`;
    expect(proposal!.origin).toBe("run");
    expect(proposal!.run_id).toBe(run!.id);

    const after = await row(schedule.id);
    expect(after.last_run_id).toBe(run!.id);
    expect(after.last_error).toBeNull();
    expect(after.consecutive_failures).toBe(0);
  });

  it("advances the clock instead of firing again on the next sweep", async () => {
    // The failure this guards is a schedule that stays due and fires every
    // sweep, which on a minute interval would be 1,440 model calls a day.
    reply = PROPOSING();
    const schedule = await make();
    await makeDue(schedule.id);

    await sweepOnce();
    const firstCalls = calls;
    expect(firstCalls).toBeGreaterThan(0);

    await sweepOnce();
    expect(calls, "the second sweep must find nothing due").toBe(firstCalls);

    const after = await row(schedule.id);
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not backfill a schedule that was missed for weeks", async () => {
    // A machine down for a fortnight must resume, not fire fourteen times to
    // catch up. The next run is computed from now, never from the missed slot.
    reply = PROPOSING();
    const schedule = await make();
    await sql`update agent_schedules set next_run_at = now() - interval '14 days'
              where id = ${schedule.id}`;

    await sweepOnce();
    const [runs] = await sql<{ n: string }[]>`
      select count(*) as n from agent_runs where workspace_id = ${ws}`;
    expect(Number(runs!.n)).toBe(1);
    expect((await row(schedule.id)).next_run_at.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("hands a due schedule to only one of two concurrent claims", async () => {
    // The database lease, tested where it actually lives. Driving this through
    // `sweepOnce` twice proves nothing: the in-process guard returns early on
    // the second call before any query runs, so the test would pass against a
    // claim that took no lease at all. Claiming directly is the only way to
    // ask the question the lease exists to answer.
    const worker = getWorkerDb();
    expect(worker, "the dispatcher's connection").toBeTruthy();
    const schedule = await make();
    await makeDue(schedule.id);

    const [a, b] = await Promise.all([
      claimDueSchedules(worker!, 10, 600),
      claimDueSchedules(worker!, 10, 600),
    ]);
    const mine = [...a, ...b].filter((r) => r.id === schedule.id);
    expect(mine).toHaveLength(1);
  });

  it("does no work on a sweep that overlaps one already running", async () => {
    // A separate guarantee from the lease above, and a cheaper one: it only
    // holds inside a single process. Both are needed, which is why they are
    // two tests rather than one that could pass on either.
    reply = PROPOSING();
    const schedule = await make();
    await makeDue(schedule.id);

    await Promise.all([sweepOnce(), sweepOnce()]);

    const [runs] = await sql<{ n: string }[]>`
      select count(*) as n from agent_runs where workspace_id = ${ws}`;
    expect(Number(runs!.n)).toBe(1);
  });

  it("records a failure, and tells the owner", async () => {
    reply = { status: 401, body: { error: { message: "bad key" } } };
    const schedule = await make();
    await makeDue(schedule.id);
    await sweepOnce();

    const after = await row(schedule.id);
    expect(after.last_error).toBeTruthy();
    expect(after.consecutive_failures).toBe(1);
    // Still on: one failure is usually the endpoint having a bad minute.
    expect(after.enabled).toBe(true);

    await relayOutbox();
    const [notice] = await sql<{ recipient_id: string; type: string }[]>`
      select recipient_id, type from notifications where workspace_id = ${ws}`;
    // The owner is told, which only works because the event carries no actor:
    // the fan-out subtracts the actor first, so naming them would deliver to
    // nobody at all.
    expect(notice!.type).toBe("schedule.failed");
    expect(notice!.recipient_id).toBe(owner);
  });

  it("switches a schedule off after three consecutive failures, and says so", async () => {
    reply = { status: 401, body: { error: { message: "bad key" } } };
    const schedule = await make();

    for (let i = 0; i < 3; i++) {
      await makeDue(schedule.id);
      await sweepOnce();
    }

    const after = await row(schedule.id);
    expect(after.consecutive_failures).toBe(3);
    expect(after.enabled, "a schedule that will never work must stop").toBe(false);

    await relayOutbox();
    const notices = await sql<{ snippet: string }[]>`
      select snippet from notifications where workspace_id = ${ws}
      order by created_at`;
    // Being switched off is itself announced. Stopping quietly is exactly the
    // failure this feature was written to avoid.
    expect(notices.at(-1)!.snippet).toMatch(/switched off/i);
  });

  it("stops sweeping a disabled schedule", async () => {
    reply = PROPOSING();
    const schedule = await make({ enabled: false });
    await makeDue(schedule.id);
    await sweepOnce();
    expect(calls).toBe(0);
  });

  it("fails loudly when the item it points at has been deleted", async () => {
    const schedule = await make();
    await makeDue(schedule.id);
    await sql`delete from features where id = ${featureId}`;
    await sweepOnce();

    const after = await row(schedule.id);
    expect(after.last_error).toMatch(/no longer exists/i);
    expect(calls, "a vanished target must not reach the model").toBe(0);
  });

  it("resets the failure count once a firing succeeds", async () => {
    reply = { status: 401, body: { error: { message: "bad key" } } };
    const schedule = await make();
    await makeDue(schedule.id);
    await sweepOnce();
    expect((await row(schedule.id)).consecutive_failures).toBe(1);

    reply = PROPOSING();
    await makeDue(schedule.id);
    await sweepOnce();
    const after = await row(schedule.id);
    expect(after.consecutive_failures).toBe(0);
    expect(after.last_error).toBeNull();
  });

  it("spends the schedule owner's budget, under their name", async () => {
    reply = PROPOSING();
    const schedule = await make();
    await makeDue(schedule.id);
    await sweepOnce();

    const [usage] = await sql<{ user_id: string; feature: string }[]>`
      select user_id, feature from model_usage_events where workspace_id = ${ws}`;
    // A scheduled run acts as the person who set it up. Attributing it to
    // nobody, or to the workspace, would make "who is spending this" an
    // unanswerable question on the one path where nobody is present.
    expect(usage!.user_id).toBe(owner);
    expect(usage!.feature).toBe("skill_run");
  });
});
