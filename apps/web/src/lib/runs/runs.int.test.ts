import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@specboards/db";

/**
 * The run lifecycle, against a migrated Postgres.
 *
 * These exist because the unit suite cannot reach any of them. Every finding
 * they cover is a race or an authorization gap between two callers, and the
 * adversarial review of v1.0.0..0c364b6 said so plainly: "the absence of
 * concurrent database tests is material to AR-01 through AR-04".
 *
 * Covered here: AR-01 (one agent reporting against another's run), the
 * cancellation, steering and duplicate-open races from AR-02, and AR-07 (a
 * read-only member controlling a run), which was found while validating the
 * report rather than in it.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const owner = randomUUID();
const reader = randomUUID();
const agentA = randomUUID();
const agentB = randomUUID();
const product = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: owner, workspaceId: ws };
const asReader = { userId: reader, workspaceId: ws };
const asAgentA = { userId: agentA, workspaceId: ws };
const asAgentB = { userId: agentB, workspaceId: ws };

describe.skipIf(!DB_URL)("the agent run lifecycle", () => {
  let sql: postgres.Sql;
  let db: Database;
  let runs: typeof import("./service");
  let types: typeof import("./types");
  let specId: string;

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 4 });
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    runs = await import("./service");
    types = await import("./types");

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Runs', ${"runs-int-" + suffix})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Owner', ${`owner-${suffix}@runs.test`}),
      (${reader}, 'Reader', ${`reader-${suffix}@runs.test`}),
      (${agentA}, 'Agent A', ${`a-${suffix}@runs.test`}),
      (${agentB}, 'Agent B', ${`b-${suffix}@runs.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner'),
      (${ws}, ${reader}, 'member'),
      (${ws}, ${agentA}, 'service'),
      (${ws}, ${agentB}, 'service')`;
    // `org` visibility so the read-only member can SEE the item. That is the
    // whole shape of AR-07: visible is not the same as controllable.
    await sql`insert into products (id, workspace_id, key, name, visibility) values
      (${product}, ${ws}, 'alpha', 'Alpha', 'org')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'work', 'Work Items', 0, true)`;
    // Both agents may write the product, so nothing below passes for the
    // boring reason that an agent could not have acted anyway.
    await sql`insert into product_members (product_id, user_id, role) values
      (${product}, ${agentA}, 'contributor'),
      (${product}, ${agentB}, 'contributor')`;

    const id = randomUUID();
    specId = id;
    await sql`insert into features (id, workspace_id, product_id, spec_id, level, title, status)
      values (${id}, ${ws}, ${product}, ${id}, 'work', 'An item', 'backlog')`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${owner}, ${reader}, ${agentA}, ${agentB})`;
    await sql.end({ timeout: 5 });
  });

  /** Clear every run between tests, so each starts from no active run. */
  async function reset() {
    await sql`delete from agent_runs where workspace_id = ${ws}`;
  }

  const open = (scope: typeof asAgentA, agentId: string) =>
    runs.openRun(db, scope, {
      specId,
      agentId,
      actorType: "agent",
      trigger: "assignment",
      summary: "Starting",
      step: null,
    });

  it("refuses one agent reporting against another agent's run", async () => {
    // AR-01. A UUID is an identifier, not an authorization boundary, and both
    // agents can read this item, so RLS does not refuse it either.
    await reset();
    const run = await open(asAgentA, agentA);

    await expect(
      runs.reportRun(db, asAgentB, run.id, {
        actorId: agentB,
        status: "succeeded",
        step: null,
      }),
    ).rejects.toBeInstanceOf(types.RunForbiddenError);

    const [row] = await sql<{ status: string }[]>`
      select status from agent_runs where id = ${run.id}`;
    expect(row!.status).toBe("running");
  });

  it("does not let a report undo a cancellation", async () => {
    // AR-02. The report reads `running`, a person cancels, and the report
    // then wrote `succeeded` straight over it.
    await reset();
    const run = await open(asAgentA, agentA);
    await runs.cancelRun(db, asOwner, run.id);

    const report = await runs.reportRun(db, asAgentA, run.id, {
      actorId: agentA,
      status: "succeeded",
      step: null,
    });
    // Reported, not thrown: being stopped is not the agent doing anything
    // wrong, and an error would invite it to retry.
    expect(report.cancelled).toBe(true);
    expect(report.status).toBe("cancelled");

    const [row] = await sql<{ status: string }[]>`
      select status from agent_runs where id = ${run.id}`;
    expect(row!.status).toBe("cancelled");
  });

  it("delivers a steering note exactly once", async () => {
    // AR-02. The note was read, then cleared by an update that did not know
    // whether a newer one had arrived, so it could vanish undelivered.
    await reset();
    const run = await open(asAgentA, agentA);
    await runs.steerRun(db, asOwner, run.id, "Skip the duplicates");

    const first = await runs.reportRun(db, asAgentA, run.id, {
      actorId: agentA,
      status: "running",
      step: null,
    });
    expect(first.steer).toBe("Skip the duplicates");

    const second = await runs.reportRun(db, asAgentA, run.id, {
      actorId: agentA,
      status: "running",
      step: null,
    });
    expect(second.steer).toBeNull();
  });

  it("keeps every trace step when reports arrive together", async () => {
    // AR-02. Each report used to write a whole replacement array built from
    // what it had read, so one of two concurrent appends was lost.
    await reset();
    const run = await open(asAgentA, agentA);
    const step = (label: string) => ({ at: new Date().toISOString(), label });

    await Promise.all([
      runs.reportRun(db, asAgentA, run.id, {
        actorId: agentA,
        status: "running",
        step: step("one"),
      }),
      runs.reportRun(db, asAgentA, run.id, {
        actorId: agentA,
        status: "running",
        step: step("two"),
      }),
    ]);

    const [row] = await sql<{ n: number }[]>`
      select jsonb_array_length(trace) as n from agent_runs where id = ${run.id}`;
    expect(row!.n).toBe(2);
  });

  it("opens one run when two opens race", async () => {
    // AR-02. `findActiveRun` then `createRun` is a read and an unconditional
    // write; the index that was supposed to stop this was not unique.
    await reset();
    const [first, second] = await Promise.all([
      open(asAgentA, agentA),
      open(asAgentA, agentA),
    ]);
    expect(second.id).toBe(first.id);

    const [row] = await sql<{ n: string }[]>`
      select count(*) as n from agent_runs
      where workspace_id = ${ws} and agent_id = ${agentA}
        and status in ('queued','running','awaiting_input')`;
    expect(row!.n).toBe("1");
  });

  it("still lets two different agents work the same item", async () => {
    // The constraint is one run per agent per target, not one run per target.
    await reset();
    const a = await open(asAgentA, agentA);
    const b = await open(asAgentB, agentB);
    expect(b.id).not.toBe(a.id);
  });

  it("refuses a read-only member cancelling or steering a run", async () => {
    // AR-07. The card hides both controls behind `canEdit`; the API did not
    // ask, so it was reachable by anyone who could see the item.
    await reset();
    const run = await open(asAgentA, agentA);

    await expect(
      runs.cancelRun(db, asReader, run.id),
    ).rejects.toBeInstanceOf(types.RunForbiddenError);
    await expect(
      runs.steerRun(db, asReader, run.id, "stop"),
    ).rejects.toBeInstanceOf(types.RunForbiddenError);

    const [row] = await sql<{ status: string; steer: string | null }[]>`
      select status, steer from agent_runs where id = ${run.id}`;
    expect(row!.status).toBe("running");
    expect(row!.steer).toBeNull();
  });

  it("still lets somebody who can write the product control a run", async () => {
    // The refusal above has to be about permission, not about the feature
    // being broken for everybody.
    await reset();
    const run = await open(asAgentA, agentA);
    await runs.steerRun(db, asOwner, run.id, "Focus on billing");
    const cancelled = await runs.cancelRun(db, asOwner, run.id);
    expect(cancelled?.status).toBe("cancelled");
  });
});
