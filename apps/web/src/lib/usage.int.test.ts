import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Usage accounting and the spend caps, against a real database.
 *
 * What is worth pinning down here is not the arithmetic, which is a SUM. It is
 * the set of promises the feature makes and can quietly stop keeping:
 *
 *  - Every call is recorded, including the ones that produced nothing. A ledger
 *    that only holds successes under-reports the bill, and under-reporting is
 *    the one direction this feature must never be wrong in.
 *  - An endpoint that reports no usage leaves a row with NULL tokens, and NULL
 *    is counted as unknown rather than as free.
 *  - A cap refuses the call that would cross it, before anything is sent, and
 *    records nothing for it.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";
// A loopback endpoint is only a legal target in the single-tenant on-prem
// configuration; both of our own deployments refuse private addresses by
// design. Same reasoning as `model-provider.int.test.ts`.
process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
delete process.env.SPECBOARDS_MULTI_TENANT;

const suffix = randomUUID().slice(0, 8);
const workspace = { id: randomUUID(), slug: `usage-${suffix}` };
const ownerId = randomUUID();
const memberId = randomUUID();

describe.skipIf(!DB_URL)("usage accounting", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let provider: typeof import("./model-provider-service");
  let usage: typeof import("./usage-service");
  let server: Server;
  let baseUrl: string;

  /**
   * What the fake endpoint does next. Reassigned per test rather than spinning
   * up a server each time: the point of the server is that a real socket is
   * involved, not that it is a different socket.
   */
  let respond: (res: import("node:http").ServerResponse) => void;

  async function ledger() {
    return sql<
      {
        feature: string;
        user_id: string;
        outcome: string;
        error_kind: string | null;
        prompt_tokens: number | null;
        completion_tokens: number | null;
      }[]
    >`select feature, user_id, outcome, error_kind, prompt_tokens, completion_tokens
        from model_usage_events
        where workspace_id = ${workspace.id}
        order by created_at`;
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    provider = await import("./model-provider-service");
    usage = await import("./usage-service");

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'Usage', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${ownerId}, 'Owner', ${`owner-${suffix}@usage.test`})`;
    await sql`insert into users (id, name, email)
      values (${memberId}, 'Member', ${`member-${suffix}@usage.test`})`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${ownerId}, 'owner')`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${memberId}, 'member')`;

    server = createServer((_req, res) => respond(res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  beforeEach(async () => {
    await sql`delete from model_usage_events where workspace_id = ${workspace.id}`;
    await sql`delete from workspace_usage_limits where workspace_id = ${workspace.id}`;
    await sql`delete from model_providers where workspace_id = ${workspace.id}`;
    await sql`insert into model_providers (workspace_id, base_url, model)
      values (${workspace.id}, ${baseUrl}, 'test-model')`;
    respond = (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { role: "assistant", content: "ready" } }],
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      );
    };
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await sql`delete from model_usage_events where workspace_id = ${workspace.id}`;
    await sql`delete from workspace_usage_limits where workspace_id = ${workspace.id}`;
    await sql`delete from model_providers where workspace_id = ${workspace.id}`;
    await sql`delete from members where workspace_id = ${workspace.id}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id in (${ownerId}, ${memberId})`;
    await sql.end();
  });

  it("records a successful call with what the endpoint reported", async () => {
    const out = await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );
    expect(out.ok).toBe(true);

    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "assistant_turn",
      user_id: memberId,
      outcome: "ok",
      prompt_tokens: 40,
      completion_tokens: 10,
    });
  });

  it("records a failed call too, with the kind that failed", async () => {
    respond = (res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    };

    const out = await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: ownerId, feature: "connection_test" },
    );
    expect(out.ok).toBe(false);

    // A failure that never reached the model costs nothing, and it is still
    // recorded: the ledger is the answer to "what did you send and when", which
    // a customer asks about failures as often as successes.
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "error",
      error_kind: "auth",
      prompt_tokens: null,
      completion_tokens: null,
    });
  });

  it("counts an unreported usage block as unknown, not as zero", async () => {
    respond = (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // No `usage` at all, which is what several self-hosted runtimes do.
      res.end(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { role: "assistant", content: "ready" } }],
        }),
      );
    };

    await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );

    const summary = await usage.summarizeUsage(db, workspace.id);
    expect(summary.calls).toBe(1);
    expect(summary.tokens).toBe(0);
    // The number that stops a total of zero being read as broken accounting.
    expect(summary.unmeasuredCalls).toBe(1);
  });

  it("attributes spend to the feature and the person", async () => {
    await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );
    await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: ownerId, feature: "breakdown" },
    );

    const summary = await usage.summarizeUsage(db, workspace.id);
    expect(summary.tokens).toBe(100);
    expect(
      Object.fromEntries(summary.byFeature.map((r) => [r.key, r.tokens])),
    ).toEqual({ assistant_turn: 50, breakdown: 50 });
    expect(
      Object.fromEntries(summary.byUser.map((r) => [r.key, r.tokens])),
    ).toEqual({ [memberId]: 50, [ownerId]: 50 });
  });

  it("refuses a call that would cross the monthly cap, and sends nothing", async () => {
    let hit = 0;
    const answered = respond;
    respond = (res) => {
      hit += 1;
      answered(res);
    };

    // 52 rather than a round 60, because the check adds the *estimate* of the
    // call about to be made before comparing. The endpoint reports 50 tokens
    // per answer, so the second call is refused on 50 already spent plus the
    // handful this one is estimated at, which is the ceiling behaviour the cap
    // is supposed to have.
    await usage.saveUsageLimits(db, workspace.id, ownerId, {
      monthlyTokenCap: 52,
    });

    // First call fits: nothing spent yet, and the estimate is small.
    const first = await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );
    expect(first.ok).toBe(true);
    expect(hit).toBe(1);

    // Second does not, and is refused before the socket is touched.
    const second = await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error.kind).toBe("capped");
    expect(hit).toBe(1);

    // And nothing is written for it: a ledger holding calls that never
    // happened cannot be reconciled against an invoice.
    expect(await ledger()).toHaveLength(1);
  });

  it("caps one person's day without capping the workspace", async () => {
    await usage.saveUsageLimits(db, workspace.id, ownerId, {
      dailyUserTokenCap: 52,
    });

    await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );
    const blocked = await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );
    expect(!blocked.ok && blocked.error.kind).toBe("capped");

    // The colleague is unaffected, which is the whole point of a per-person cap
    // as opposed to a smaller workspace one.
    const other = await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: ownerId, feature: "assistant_turn" },
    );
    expect(other.ok).toBe(true);
  });

  it("treats no limits row as uncapped rather than as zero", async () => {
    expect(await usage.getUsageLimits(db, workspace.id)).toMatchObject({
      monthlyTokenCap: null,
      dailyUserTokenCap: null,
    });
    const out = await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );
    expect(out.ok).toBe(true);
  });

  it("clears a cap when it is saved as null", async () => {
    await usage.saveUsageLimits(db, workspace.id, ownerId, {
      monthlyTokenCap: 10,
    });
    const cleared = await usage.saveUsageLimits(db, workspace.id, ownerId, {
      monthlyTokenCap: null,
    });
    expect(cleared.monthlyTokenCap).toBeNull();

    const out = await provider.completeWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    );
    expect(out.ok).toBe(true);
  });

  it("refuses a cap that is not a whole number of tokens", async () => {
    await expect(
      usage.saveUsageLimits(db, workspace.id, ownerId, {
        monthlyTokenCap: "lots",
      }),
    ).rejects.toThrow(/whole number/);
    await expect(
      usage.saveUsageLimits(db, workspace.id, ownerId, {
        monthlyTokenCap: -1,
      }),
    ).rejects.toThrow(/whole number/);
  });

  it("records a cancelled stream, because the tokens were still billed", async () => {
    respond = (res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      // Deltas and then nothing: the connection is left open, so the only way
      // this ends is the reader walking away, which is what a cancel is.
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "tial" } }] })}\n\n`,
      );
    };

    const controller = new AbortController();
    const stream = provider.streamWithWorkspaceModel(
      db,
      workspace.id,
      {
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      },
      { userId: memberId, feature: "assistant_turn" },
    );

    for await (const event of stream) {
      if (event.kind === "delta") {
        // Stop reading, as the panel does when somebody presses cancel.
        controller.abort();
        await stream.return(undefined);
        break;
      }
    }

    // The row that would not exist if recording hung off the terminal event:
    // the provider generated and billed those tokens, and a customer who
    // cancels twice a day would find them on an invoice with nothing in the
    // product that mentions them.
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "cancelled",
      prompt_tokens: null,
      completion_tokens: null,
    });
  });

  it("records a completed stream with the usage it reported", async () => {
    respond = (res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(
        `data: ${JSON.stringify({
          model: "test-model",
          choices: [{ delta: { content: "ready" } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          model: "test-model",
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    };

    for await (const _event of provider.streamWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    )) {
      // Drained; the assertions are about what was written, not what was read.
    }

    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "ok",
      prompt_tokens: 7,
      completion_tokens: 3,
    });
  });

  it("refuses a capped stream with a message rather than an error event", async () => {
    await usage.saveUsageLimits(db, workspace.id, ownerId, {
      monthlyTokenCap: 0,
    });

    const events = [];
    for await (const event of provider.streamWithWorkspaceModel(
      db,
      workspace.id,
      { messages: [{ role: "user", content: "hi" }] },
      { userId: memberId, feature: "assistant_turn" },
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("capped");
    // A cap of zero is a real instruction ("stop entirely"), distinct from no
    // cap at all, and this is the case that proves the two are not conflated.
    expect(await ledger()).toHaveLength(0);
  });
});
