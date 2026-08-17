import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The assistant against a real database: what a question actually does.
 *
 * Two kinds of endpoint are used here on purpose.
 *
 * Most of this drives a **stub** OpenAI-compatible server, because the claims
 * worth pinning are about what Specboards sends and stores, and only a server
 * we control can be asked what it received. Whether a real runtime speaks the
 * protocol is a different question, already answered by
 * `ai/self-hosted.int.test.ts`; repeating it here would slow the suite down
 * without testing anything new.
 *
 * One test at the end drives a **real** runtime when one is configured, so the
 * end-to-end claim ("a question in the panel reaches a model and comes back")
 * rests on something other than a server written by the same person as the
 * assertions.
 *
 * Runs against DATABASE_URL; skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";
// The stub endpoint is on loopback, which the egress policy refuses unless a
// deployment opts in. Needing this is the same opt-in an on-prem install makes.
process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
delete process.env.SPECBOARDS_MULTI_TENANT;

const suffix = randomUUID().slice(0, 8);
const ws = randomUUID();
const user = { owner: randomUUID(), outsider: randomUUID() };
const openProduct = randomUUID();
const closedProduct = randomUUID();

const asOwner = { userId: user.owner, workspaceId: ws };
const asOutsider = { userId: user.outsider, workspaceId: ws };

/** The last request body the stub endpoint received, parsed. */
interface CapturedRequest {
  model: string;
  messages: { role: string; content: string }[];
}

describe.skipIf(!DB_URL)("the assistant on an item", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let svc: typeof import("./assistant-service");
  let providers: typeof import("./model-provider-service");
  let server: Server;
  let endpoint: string;
  let specId: string;
  let closedSpecId: string;

  /** Set to make the stub fail the next call, exercising the failure path. */
  let failNext = false;
  let captured: CapturedRequest[] = [];

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    svc = await import("./assistant-service");
    providers = await import("./model-provider-service");

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/chat/completions")) {
          captured.push(JSON.parse(body) as CapturedRequest);
          if (failNext) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "bad key" } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              model: "stub-model-v1",
              choices: [{ message: { role: "assistant", content: "A stub answer." } }],
              usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Assistant', ${`asst-${suffix}`})`;
    await sql`insert into users (id, name, email) values
      (${user.owner}, 'Ada', ${`ada-${suffix}@asst.test`}),
      (${user.outsider}, 'Outsider', ${`out-${suffix}@asst.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.outsider}, 'member')`;
    await sql`insert into products (id, workspace_id, key, name, visibility) values
      (${openProduct}, ${ws}, 'alpha', 'Alpha', 'org'),
      (${closedProduct}, ${ws}, 'secret', 'Secret', 'private')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;

    const { getStore } = await import("./store");
    const store = await getStore();
    const item = await store.createFeature(
      {
        title: "Rate limiting",
        level: "epic",
        productId: openProduct,
        details: "Throttle the public API. Unclear what happens on burst.",
      },
      asOwner,
    );
    specId = item.specId;
    const closed = await store.createFeature(
      { title: "Acquisition plan", level: "epic", productId: closedProduct },
      asOwner,
    );
    closedSpecId = closed.specId;
  });

  beforeEach(async () => {
    failNext = false;
    captured = [];
    await sql`delete from assistant_messages where workspace_id = ${ws}`;
    await sql`delete from model_providers where workspace_id = ${ws}`;
    await sql`delete from model_provider_credentials where workspace_id = ${ws}`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${user.owner}, ${user.outsider})`;
    await sql.end({ timeout: 5 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE;
  });

  /** Point the workspace at the stub endpoint. */
  async function connectStub() {
    await providers.saveModelProvider(db, ws, {
      baseUrl: endpoint,
      model: "stub-model",
      apiKey: "sk-stub-key-0001",
    });
  }

  it("answers a question and records both turns", async () => {
    await connectStub();
    const outcome = await svc.sendAssistantMessage(
      db,
      asOwner,
      specId,
      "  What is missing here?  ",
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.turns).toHaveLength(2);
    expect(outcome.turns[0]!.role).toBe("user");
    expect(outcome.turns[0]!.content).toBe("What is missing here?"); // trimmed
    expect(outcome.turns[1]!.role).toBe("assistant");
    expect(outcome.turns[1]!.content).toBe("A stub answer.");
    // The model that actually answered, not the one asked for: a gateway is
    // free to substitute, and this is what the panel shows.
    expect(outcome.turns[1]!.model).toBe("stub-model-v1");

    const thread = await svc.listAssistantThread(db, asOwner, specId);
    expect(thread.map((m) => m.role)).toEqual(["user", "assistant"]);
    // Both rows name the person, so a thread read months later says who drove
    // it rather than attributing half of it to nobody.
    expect(thread.every((m) => m.authorId === user.owner)).toBe(true);
    expect(thread[0]!.authorName).toBe("Ada");
    expect(thread[1]!.authorName).toBe("Ada");
  });

  it("records what the answer cost, as the endpoint reported it", async () => {
    await connectStub();
    await svc.sendAssistantMessage(db, asOwner, specId, "Anything?");

    const [row] = await sql<{ prompt_tokens: number; completion_tokens: number }[]>`
      select prompt_tokens, completion_tokens from assistant_messages
      where workspace_id = ${ws} and role = 'assistant'`;
    expect(row!.prompt_tokens).toBe(31);
    expect(row!.completion_tokens).toBe(7);
  });

  it("sends the item's own content, and nothing about anyone", async () => {
    await connectStub();
    await svc.sendAssistantMessage(db, asOwner, specId, "Grill me.");

    const system = captured[0]!.messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("Rate limiting");
    expect(system).toContain("Throttle the public API");
    expect(system).toContain("Epics"); // the workspace's own level label
    // The names and addresses of the people in this workspace are not the
    // customer's to leak to a third-party endpoint on our initiative.
    expect(system).not.toContain("Ada");
    expect(system).not.toContain("@asst.test");
    // Nor another item, even one this member can read.
    expect(system).not.toContain("Acquisition plan");
  });

  it("replays the conversation so far on the next question", async () => {
    await connectStub();
    await svc.sendAssistantMessage(db, asOwner, specId, "First question.");
    await svc.sendAssistantMessage(db, asOwner, specId, "Second question.");

    const second = captured[1]!.messages;
    expect(second.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(second[1]!.content).toBe("First question.");
    expect(second[2]!.content).toBe("A stub answer.");
    expect(second[3]!.content).toBe("Second question.");
  });

  it("caps how much history is replayed", async () => {
    await connectStub();
    for (let i = 0; i < svc.HISTORY_TURN_LIMIT; i++) {
      await svc.sendAssistantMessage(db, asOwner, specId, `Question ${i}.`);
    }
    const last = captured.at(-1)!.messages;
    // System + the capped history + the new question. Without the cap a long
    // thread eventually exceeds the context window of the small local model
    // this epic exists to support, and the failure arrives as a wall of
    // provider error rather than as anything a user can act on.
    expect(last).toHaveLength(svc.HISTORY_TURN_LIMIT + 2);
    expect(last[0]!.role).toBe("system");
    expect(last.at(-1)!.content).toBe(
      `Question ${svc.HISTORY_TURN_LIMIT - 1}.`,
    );
  });

  it("writes nothing when the model call fails", async () => {
    await connectStub();
    failNext = true;
    const outcome = await svc.sendAssistantMessage(db, asOwner, specId, "Hello?");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("auth");
    // A question with no answer under it reads as the assistant ignoring
    // someone, and it replays into the next request as an unanswered turn.
    expect(await svc.listAssistantThread(db, asOwner, specId)).toHaveLength(0);
  });

  it("says so plainly when no model is connected", async () => {
    const outcome = await svc.sendAssistantMessage(db, asOwner, specId, "Hi.");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("not_configured");
    expect(outcome.error.message).toMatch(/Settings/i);
    expect(await svc.isModelConnected(db, ws)).toBe(false);
  });

  it("reports a connected model before anyone spends a token", async () => {
    await connectStub();
    expect(await svc.isModelConnected(db, ws)).toBe(true);
  });

  it("refuses an item the caller cannot see", async () => {
    await connectStub();
    // The private product is the whole point: reading the thread about an item
    // would otherwise be a way to read the item, since the thread quotes it.
    await expect(
      svc.listAssistantThread(db, asOutsider, closedSpecId),
    ).rejects.toThrow(svc.AssistantItemError);
    await expect(
      svc.sendAssistantMessage(db, asOutsider, closedSpecId, "What is this?"),
    ).rejects.toThrow(svc.AssistantItemError);
    expect(captured).toHaveLength(0);
  });

  it("rejects an empty question without calling anything", async () => {
    await connectStub();
    await expect(
      svc.sendAssistantMessage(db, asOwner, specId, "   "),
    ).rejects.toThrow(svc.AssistantInputError);
    expect(captured).toHaveLength(0);
  });

  it("rejects a question longer than the endpoint would take", async () => {
    await connectStub();
    await expect(
      svc.sendAssistantMessage(db, asOwner, specId, "x".repeat(svc.MAX_TURN_CHARS + 1)),
    ).rejects.toThrow(svc.AssistantInputError);
    expect(captured).toHaveLength(0);
  });

  it("discloses exactly the fields it will send", async () => {
    const { context: disclosed } = await svc.getAssistantPanelData(
      db,
      asOwner,
      specId,
    );
    const labels = disclosed.map((f) => f.label);
    expect(labels).toContain("Title");
    expect(labels).toContain("Description");
    // Asked before any question is sent, so the panel can show it up front.
    expect(captured).toHaveLength(0);

    await connectStub();
    await svc.sendAssistantMessage(db, asOwner, specId, "Now ask.");
    const system = captured[0]!.messages.find((m) => m.role === "system")!.content;
    for (const field of disclosed) expect(system).toContain(field.value);
  });
});

/**
 * The same path against a runtime nobody here wrote.
 *
 * Opt in by pointing it at one, which keeps a GPU-less CI green:
 *
 *   docker run -d -v ollama:/root/.ollama -p 127.0.0.1:11434:11434 \
 *     --name specboards-ollama ollama/ollama
 *   docker exec specboards-ollama ollama pull qwen2.5:0.5b
 *   DATABASE_URL=postgres://... \
 *   SPECBOARDS_TEST_MODEL_URL=http://127.0.0.1:11434/v1 \
 *   SPECBOARDS_TEST_MODEL=qwen2.5:0.5b \
 *     pnpm vitest run --config vitest.int.config.ts src/lib/assistant.int.test.ts
 */
const RUNTIME_URL = process.env.SPECBOARDS_TEST_MODEL_URL;
const RUNTIME_MODEL = process.env.SPECBOARDS_TEST_MODEL ?? "qwen2.5:0.5b";

describe.skipIf(!DB_URL || !RUNTIME_URL)(
  "the assistant against a self-hosted runtime",
  () => {
    let sql: postgres.Sql;
    let db: import("@specboards/db").Database;
    let svc: typeof import("./assistant-service");
    const rtWs = randomUUID();
    const rtUser = randomUUID();
    const rtProduct = randomUUID();
    const rtSuffix = randomUUID().slice(0, 8);
    const scope = { userId: rtUser, workspaceId: rtWs };
    let rtSpecId: string;

    beforeAll(async () => {
      // Set here as well as at the top of the file: the suite above clears it
      // in its own teardown, which runs before this one starts. Each suite
      // owning the environment it needs is why that teardown can stay.
      process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
      const { createDb } = await import("@specboards/db");
      db = createDb(DB_URL!);
      svc = await import("./assistant-service");
      const providers = await import("./model-provider-service");

      sql = postgres(DB_URL!, { prepare: false, max: 2 });
      await sql`insert into workspaces (id, name, slug)
        values (${rtWs}, 'Runtime', ${`rt-${rtSuffix}`})`;
      await sql`insert into users (id, name, email)
        values (${rtUser}, 'Grace', ${`grace-${rtSuffix}@asst.test`})`;
      await sql`insert into members (workspace_id, user_id, role)
        values (${rtWs}, ${rtUser}, 'owner')`;
      await sql`insert into products (id, workspace_id, key, name)
        values (${rtProduct}, ${rtWs}, 'alpha', 'Alpha')`;
      await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
        values (${rtWs}, 'epic', 'Epics', 0, false), (${rtWs}, 'story', 'Stories', 1, true)`;

      const { getStore } = await import("./store");
      const store = await getStore();
      const item = await store.createFeature(
        { title: "Offline export", level: "epic", productId: rtProduct },
        scope,
      );
      rtSpecId = item.specId;

      await providers.saveModelProvider(db, rtWs, {
        baseUrl: RUNTIME_URL!,
        model: RUNTIME_MODEL,
        apiKey: null,
      });
    });

    afterAll(async () => {
      await sql`delete from workspaces where id = ${rtWs}`;
      await sql`delete from users where id = ${rtUser}`;
      await sql.end({ timeout: 5 });
      delete process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE;
    });

    it(
      "answers from the real model and persists the exchange",
      async () => {
        const outcome = await svc.sendAssistantMessage(
          db,
          scope,
          rtSpecId,
          "In one sentence, what is the biggest gap in this definition?",
        );

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // Not asserted: what it says. A 0.5B model on CPU says whatever it
        // likes, and asserting on content would make this a test of the model
        // rather than of the path to it.
        expect(outcome.turns[1]!.content.length).toBeGreaterThan(0);
        expect(outcome.turns[1]!.model).toBe(RUNTIME_MODEL);

        const thread = await svc.listAssistantThread(db, scope, rtSpecId);
        expect(thread).toHaveLength(2);
        expect(thread[1]!.content).toBe(outcome.turns[1]!.content);
      },
      // A small model on CPU is not fast, and the first call loads weights.
      120_000,
    );
  },
);
