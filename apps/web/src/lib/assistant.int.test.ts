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

/**
 * The item's description at the start of every test. Restored in `beforeEach`
 * because the proposal tests below actually change it, and a test that reads
 * "the assistant is sent the item's content" must not depend on which tests ran
 * before it.
 */
const ITEM_BODY = "Throttle the public API. Unclear what happens on burst.";

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
  /** Pace the stub's frames so a turn can be cancelled part-way through. */
  let slow = false;
  /** Set by the stub when the client hung up, which is how a cancel looks
   * from the provider's side and the only signal it ever gets. */
  let disconnected = false;
  let captured: CapturedRequest[] = [];
  /** What the stub answers with, in frames. Replaced by the proposal tests. */
  let answerFrames = ["A ", "stub ", "answer."];

  /**
   * Run a turn to completion, collecting what a caller would observe.
   *
   * The production path is a stream, so the tests drive the stream. Draining
   * it here rather than keeping a second non-streaming entry point means there
   * is exactly one implementation of "what gets persisted", instead of two
   * that have to be kept in agreement.
   */
  async function ask(
    scope: { userId: string; workspaceId: string },
    id: string,
    text: string,
    opts: {
      signal?: AbortSignal;
      onDelta?: (t: string) => void;
      skillKey?: string | null;
    } = {},
  ) {
    const turn = await svc.startAssistantTurn(db, scope, id, text, opts);
    const deltas: string[] = [];
    let done: import("./assistant-service").AssistantMessageView[] | null = null;
    let error: { kind: string; message: string } | null = null;
    for await (const event of turn) {
      if (event.kind === "delta") {
        deltas.push(event.text);
        opts.onDelta?.(event.text);
      } else if (event.kind === "done") done = event.turns;
      else error = event.error;
    }
    return { deltas, text: deltas.join(""), turns: done, error };
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    svc = await import("./assistant-service");
    providers = await import("./model-provider-service");

    // A streaming stub. It answers "A stub answer." in three frames, which is
    // what makes reassembly a real assertion rather than a formality: a client
    // that only handled one-frame answers would pass against a non-streaming
    // stub and lose two thirds of every real reply.
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        if (!req.url?.endsWith("/chat/completions")) {
          res.writeHead(404).end();
          return;
        }
        const request = JSON.parse(body) as CapturedRequest & { stream?: boolean };
        captured.push(request);
        if (failNext) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad key" } }));
          return;
        }

        // A breakdown is a plain completion, not a stream. Honouring the flag
        // rather than always streaming is what makes this stub able to stand in
        // for both, and answering SSE to a non-streaming request is exactly the
        // protocol mismatch a real endpoint would never produce.
        if (!request.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              model: "stub-model-v1",
              choices: [
                { message: { role: "assistant", content: answerFrames.join("") } },
              ],
              usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
            }),
          );
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const frame = (payload: unknown) =>
          res.write(`data: ${JSON.stringify(payload)}\n\n`);

        // Per-request, not shared. `close` fires at the end of EVERY response,
        // so a shared flag would latch after the first call and make the stub
        // refuse every later one.
        let hungUp = false;
        res.on("close", () => {
          hungUp = true;
          // Only an early close is a client hanging up. A response that
          // finished normally also emits `close`, and counting that as a
          // disconnect would make the cancel assertion pass for free.
          if (!res.writableFinished) disconnected = true;
        });

        for (const part of answerFrames) {
          if (hungUp) return;
          frame({ model: "stub-model-v1", choices: [{ delta: { content: part } }] });
          // In slow mode the caller gets time to hit Stop between frames.
          if (slow) await new Promise((r) => setTimeout(r, 300));
        }
        if (hungUp) return;
        frame({
          model: "stub-model-v1",
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
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
        details: ITEM_BODY,
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
    slow = false;
    disconnected = false;
    captured = [];
    answerFrames = ["A ", "stub ", "answer."];
    await sql`delete from assistant_messages where workspace_id = ${ws}`;
    await sql`delete from model_providers where workspace_id = ${ws}`;
    await sql`delete from model_provider_credentials where workspace_id = ${ws}`;
    await sql`update features set details = ${ITEM_BODY}
      where workspace_id = ${ws} and spec_id = ${specId}`;
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
    const outcome = await ask(asOwner, specId, "  What is missing here?  ");

    // Delivered in pieces, and reassembled into the answer that gets stored.
    expect(outcome.deltas.length).toBeGreaterThan(1);
    expect(outcome.text).toBe("A stub answer.");

    expect(outcome.error).toBeNull();
    expect(outcome.turns).toHaveLength(2);
    expect(outcome.turns![0]!.role).toBe("user");
    expect(outcome.turns![0]!.content).toBe("What is missing here?"); // trimmed
    expect(outcome.turns![1]!.role).toBe("assistant");
    expect(outcome.turns![1]!.content).toBe("A stub answer.");
    // The model that actually answered, not the one asked for: a gateway is
    // free to substitute, and this is what the panel shows.
    expect(outcome.turns![1]!.model).toBe("stub-model-v1");

    const thread = await svc.listAssistantThread(db, asOwner, specId);
    expect(thread.map((m) => m.role)).toEqual(["user", "assistant"]);
    // Both rows name the person, so a thread read months later says who drove
    // it rather than attributing half of it to nobody.
    expect(thread.every((m) => m.authorId === user.owner)).toBe(true);
    expect(thread[0]!.authorName).toBe("Ada");
    expect(thread[1]!.authorName).toBe("Ada");
  });

  it("asks the endpoint to stream", async () => {
    await connectStub();
    await ask(asOwner, specId, "Anything?");
    // Without this the endpoint would answer in one piece and every claim
    // about progressive rendering above would be vacuously true.
    expect((captured[0] as unknown as { stream: boolean }).stream).toBe(true);
  });

  it("records what the answer cost, as the endpoint reported it", async () => {
    await connectStub();
    await ask(asOwner, specId, "Anything?");

    const [row] = await sql<{ prompt_tokens: number; completion_tokens: number }[]>`
      select prompt_tokens, completion_tokens from assistant_messages
      where workspace_id = ${ws} and role = 'assistant'`;
    expect(row!.prompt_tokens).toBe(31);
    expect(row!.completion_tokens).toBe(7);
  });

  it("sends the item's own content, and nothing about anyone", async () => {
    await connectStub();
    await ask(asOwner, specId, "Grill me.");

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
    await ask(asOwner, specId, "First question.");
    await ask(asOwner, specId, "Second question.");

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
      await ask(asOwner, specId, `Question ${i}.`);
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
    const outcome = await ask(asOwner, specId, "Hello?");

    expect(outcome.turns).toBeNull();
    expect(outcome.error?.kind).toBe("auth");
    // A question with no answer under it reads as the assistant ignoring
    // someone, and it replays into the next request as an unanswered turn.
    expect(await svc.listAssistantThread(db, asOwner, specId)).toHaveLength(0);
  });

  it("keeps nothing when a turn is stopped part-way through", async () => {
    await connectStub();
    slow = true;
    const controller = new AbortController();
    // Abort as soon as there is something on screen, which is the only moment
    // Stop is reachable in the UI: before the first token there is nothing to
    // stop, and after the last there is nothing left to stop.
    const outcome = await ask(asOwner, specId, "Stop me.", {
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });

    expect(outcome.deltas.length).toBeGreaterThan(0);
    // No terminal event: not a completed answer, and not an error either.
    expect(outcome.turns).toBeNull();
    expect(outcome.error).toBeNull();
    // A partial answer replayed as history would drag every later answer with
    // it, and an aborted stream never carries the usage a row would need.
    expect(await svc.listAssistantThread(db, asOwner, specId)).toHaveLength(0);
    // The provider is told by the connection closing; there is no cancel call
    // in the protocol. Without this it keeps generating tokens we still pay
    // for and nobody will ever read.
    await new Promise((r) => setTimeout(r, 100));
    expect(disconnected).toBe(true);
  });

  it("says so plainly when no model is connected", async () => {
    const outcome = await ask(asOwner, specId, "Hi.");
    expect(outcome.error?.kind).toBe("not_configured");
    expect(outcome.error?.message).toMatch(/Settings/i);
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
      ask(asOutsider, closedSpecId, "What is this?"),
    ).rejects.toThrow(svc.AssistantItemError);
    expect(captured).toHaveLength(0);
  });

  it("rejects an empty question without calling anything", async () => {
    await connectStub();
    await expect(
      ask(asOwner, specId, "   "),
    ).rejects.toThrow(svc.AssistantInputError);
    expect(captured).toHaveLength(0);
  });

  it("rejects a question longer than the endpoint would take", async () => {
    await connectStub();
    await expect(
      ask(asOwner, specId, "x".repeat(svc.MAX_TURN_CHARS + 1)),
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
    await ask(asOwner, specId, "Now ask.");
    const system = captured[0]!.messages.find((m) => m.role === "system")!.content;
    for (const field of disclosed) expect(system).toContain(field.value);
  });

  /**
   * Breaking an item down into the level below it.
   *
   * The claim under test is the same negative one as for an edit: a model
   * listing eight child items must leave the board with exactly as many items
   * as it had. Creating them is the caller's job through the ordinary create
   * path, so what is pinned here is what comes *back*, and that nothing moves.
   */
  describe("breaking an item down", () => {
    let breakdown: typeof import("./breakdown-service");

    /** Make the stub answer with a list of children. */
    const proposing = (...titles: string[]) => {
      answerFrames = [
        "Split by surface.\n\n<<<BEGIN PROPOSED BREAKDOWN>>>\n",
        titles.map((t) => `- ${t}\n  What ${t.toLowerCase()} covers.`).join("\n"),
        "\n<<<END PROPOSED BREAKDOWN>>>",
      ];
    };

    const childCount = async () => {
      const [row] = await sql<{ n: string }[]>`
        select count(*) as n from features
        where workspace_id = ${ws} and parent_id = (
          select id from features
          where workspace_id = ${ws} and spec_id = ${specId})`;
      return Number(row!.n);
    };

    beforeAll(async () => {
      breakdown = await import("./breakdown-service");
    });

    beforeEach(async () => {
      await connectStub();
    });

    it("proposes the level below and creates nothing", async () => {
      proposing("Connect a provider", "Ask a question");
      const before = await childCount();
      const outcome = await breakdown.proposeBreakdown(db, asOwner, specId);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.children.map((c) => c.title)).toEqual([
        "Connect a provider",
        "Ask a question",
      ]);
      expect(outcome.prose).toBe("Split by surface.");
      // The whole rule: a proposal is a list, not an action.
      expect(await childCount()).toBe(before);
    });

    it("asks for the level the workspace actually has below this one", async () => {
      // Levels are configurable. This workspace calls them Epics and Stories,
      // so an epic breaks down into Stories and nothing else.
      proposing("A story");
      const outcome = await breakdown.proposeBreakdown(db, asOwner, specId);
      expect(outcome.ok && outcome.childLevelKey).toBe("story");
      expect(outcome.ok && outcome.childLevelLabel).toBe("Stories");

      const system = captured.at(-1)!.messages.find((m) => m.role === "system")!
        .content;
      expect(system).toContain("Stories items");
    });

    it("does not ask a completion endpoint to stream", async () => {
      // A breakdown is only useful whole. Streaming it would mean tick boxes
      // that appear and rename themselves while somebody reads them.
      proposing("A story");
      await breakdown.proposeBreakdown(db, asOwner, specId);
      expect(
        (captured.at(-1) as unknown as { stream?: boolean }).stream,
      ).toBeFalsy();
    });

    it("drops anything that repeats a child already there", async () => {
      // The prompt asks for the gap; this is the backstop. A duplicate that
      // slips through becomes a second card with the same name that somebody
      // has to notice and delete.
      const store = await (await import("./store")).getStore();
      await store.createFeature(
        { title: "Connect a provider", level: "story", parentSpecId: specId },
        asOwner,
      );
      proposing("Connect a provider.", "Ask a question");
      const outcome = await breakdown.proposeBreakdown(db, asOwner, specId);

      // Matched loosely: trailing punctuation and case do not make a new card.
      expect(outcome.ok && outcome.children.map((c) => c.title)).toEqual([
        "Ask a question",
      ]);
      await sql`delete from features
        where workspace_id = ${ws} and level = 'story'`;
    });

    it("drops a repeat within one proposal", async () => {
      proposing("Ask a question", "ask a question");
      const outcome = await breakdown.proposeBreakdown(db, asOwner, specId);
      expect(outcome.ok && outcome.children).toHaveLength(1);
    });

    it("tells the model what is already under the parent", async () => {
      const store = await (await import("./store")).getStore();
      await store.createFeature(
        { title: "Connect a provider", level: "story", parentSpecId: specId },
        asOwner,
      );
      proposing("Ask a question");
      await breakdown.proposeBreakdown(db, asOwner, specId);

      const system = captured.at(-1)!.messages.find((m) => m.role === "system")!
        .content;
      expect(system).toContain("Connect a provider");
      expect(system).toMatch(/only what is missing/);
      await sql`delete from features
        where workspace_id = ${ws} and level = 'story'`;
    });

    it("refuses an item that is already at the lowest level", async () => {
      const store = await (await import("./store")).getStore();
      const leaf = await store.createFeature(
        { title: "A story", level: "story", parentSpecId: specId },
        asOwner,
      );
      await expect(
        breakdown.proposeBreakdown(db, asOwner, leaf.specId),
      ).rejects.toThrow(breakdown.BreakdownLevelError);
      // Refused before anything was spent, which is the point of checking it
      // here rather than letting the model propose into a level that is not
      // there and failing on create.
      expect(captured).toHaveLength(0);
      await sql`delete from features
        where workspace_id = ${ws} and level = 'story'`;
    });

    it("refuses someone who cannot add items under it", async () => {
      proposing("A story");
      await expect(
        breakdown.proposeBreakdown(db, asOutsider, specId),
      ).rejects.toThrow(breakdown.BreakdownForbiddenError);
      // Nothing spent. Proposing work for someone who has no button to press
      // costs the workspace money to produce a list they cannot use.
      expect(captured).toHaveLength(0);
    });

    it("refuses an item the caller cannot see", async () => {
      await expect(
        breakdown.proposeBreakdown(db, asOutsider, closedSpecId),
      ).rejects.toThrow(svc.AssistantItemError);
      expect(captured).toHaveLength(0);
    });

    it("reports a considered empty breakdown as a success", async () => {
      // The model is told to propose nothing when the parent already looks
      // fully broken down, so an empty list is an answer and its sentence is
      // the useful part. Reporting it as a failure would be a lie.
      answerFrames = [
        "This is already covered by the items under it.\n",
        "<<<BEGIN PROPOSED BREAKDOWN>>>\n<<<END PROPOSED BREAKDOWN>>>",
      ];
      const outcome = await breakdown.proposeBreakdown(db, asOwner, specId);
      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.children).toEqual([]);
      expect(outcome.ok && outcome.prose).toMatch(/already covered/);
    });

    it("says so plainly when no model is connected", async () => {
      await sql`delete from model_providers where workspace_id = ${ws}`;
      const outcome = await breakdown.proposeBreakdown(db, asOwner, specId);
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error.kind).toBe("not_configured");
      expect(!outcome.ok && outcome.error.message).toMatch(/Settings/i);
    });
  });

  /**
   * Proposed edits: what an answer containing one does, and does not, do.
   *
   * The claim under test is the epic's hard constraint, and it is a *negative*
   * one: a model saying it has rewritten the spec must leave the spec exactly
   * as it was. Negative claims are the ones that quietly stop being true, so
   * the item's body is read back from the database after every step here rather
   * than inferred from what the call returned.
   *
   * These items are DB-native cards, so accepting goes through `patchFeature`.
   * The git-backed branch calls `updateSpecContent`, the same function the spec
   * editor's own Save calls, and is not exercised here: it needs a connected
   * repository, which this suite has none of.
   */
  describe("an edit the assistant proposed", () => {
    let proposals: typeof import("./assistant-proposals");
    const NEW_BODY = "# Rate limiting\n\nThrottle the public API.\n\n## On burst\n\nReturn 429.";

    /** Make the stub answer with a proposal, and ask for one. */
    async function propose(scope = asOwner) {
      answerFrames = [
        "I added a section on burst behaviour.\n\n",
        "<<<BEGIN PROPOSED SPEC>>>\n",
        `${NEW_BODY}\n`,
        "<<<END PROPOSED SPEC>>>",
      ];
      const outcome = await ask(scope, specId, "Write the burst behaviour.");
      return outcome.turns![1]!;
    }

    /**
     * The assistant turns replayed into the last request.
     *
     * Assistant turns specifically: the system prompt quotes the proposal
     * markers in its own instructions, so a search across all messages matches
     * that and reports nothing about what the history actually carried.
     */
    const replayedAssistantTurns = () =>
      captured
        .at(-1)!
        .messages.filter((m) => m.role === "assistant")
        .map((m) => m.content);

    /** The item's description as the database has it right now. */
    async function bodyNow() {
      const [row] = await sql<{ details: string | null }[]>`
        select details from features
        where workspace_id = ${ws} and spec_id = ${specId}`;
      return row!.details;
    }

    beforeAll(async () => {
      proposals = await import("./assistant-proposals");
    });

    beforeEach(async () => {
      await connectStub();
    });

    it("changes nothing by itself", async () => {
      const turn = await propose();

      // The whole rule, stated as an assertion: the model produced an edit and
      // the item is untouched.
      expect(await bodyNow()).toBe(ITEM_BODY);
      expect(turn.proposal).not.toBeNull();
      expect(turn.proposal!.outcome).toBeNull();
      // The prose and the proposal are both kept in the stored message, so a
      // reload shows the same thing the live answer did.
      expect(turn.content).toContain("burst behaviour");
      expect(turn.content).toContain("BEGIN PROPOSED SPEC");
    });

    it("applies to the item once a person accepts it", async () => {
      const turn = await propose();
      const result = await proposals.acceptProposal(db, asOwner, specId, turn.id);

      expect(await bodyNow()).toBe(NEW_BODY);
      expect(result.body).toBe(NEW_BODY);
      expect(result.message.proposal!.outcome).toBe("accepted");
      // Named, because "a human accepted it" is the claim, and an accept
      // credited to nobody cannot support it.
      expect(result.message.proposal!.resolvedByName).toBe("Ada");
      expect(result.message.proposal!.resolvedAt).not.toBeNull();
    });

    it("applies the reviewer's own text when they edited it first", async () => {
      const turn = await propose();
      const mine = `${NEW_BODY}\n\nRetry after the window closes.`;
      await proposals.acceptProposal(db, asOwner, specId, turn.id, { body: mine });

      // What lands is what the person approved, not what the model wrote.
      expect(await bodyNow()).toBe(mine);
    });

    it("applies only the changes the reviewer ticked", async () => {
      // Accept-in-part. The selection is made in the browser and arrives here
      // as a body, so what this pins is that the composed document survives the
      // write intact: the taken change lands, the untaken one leaves the
      // original line exactly where it was, and nothing in between moves.
      const { composeFromHunks, diffHunks, diffLines } = await import(
        "@specboards/core"
      );
      // Spaced out on purpose. Two edits within a few lines of each other are
      // deliberately one hunk (their context windows touch), which is right for
      // reading and useless for testing a choice between two.
      const long = [
        "# Rate limiting",
        "",
        "Throttle the public API.",
        "",
        "## Limits",
        "",
        "Sixty a minute.",
        "",
        "## Who it applies to",
        "",
        "Every unauthenticated caller.",
        "Authenticated callers get their own budget.",
        "Internal services are exempt.",
        "",
        "## Rollout",
        "",
        "Behind a flag for the first week.",
        "",
        "## Open questions",
        "",
        "What happens on burst?",
      ].join("\n");
      await sql`update features set details = ${long}
        where workspace_id = ${ws} and spec_id = ${specId}`;

      const rewritten = long
        .replace("Sixty a minute.", "Sixty a minute, per API key.")
        .replace("What happens on burst?", "Burst returns 429 with Retry-After.");
      answerFrames = [
        "Two changes.\n\n<<<BEGIN PROPOSED SPEC>>>\n",
        `${rewritten}\n`,
        "<<<END PROPOSED SPEC>>>",
      ];
      const turn = (await ask(asOwner, specId, "Tighten both sections.")).turns![1]!;

      // Two separate regions, which is what makes a partial choice meaningful.
      const hunks = diffHunks(diffLines(long, rewritten));
      expect(hunks).toHaveLength(2);

      const onlyTheSecond = composeFromHunks(long, rewritten, new Set([1]));
      await proposals.acceptProposal(db, asOwner, specId, turn.id, {
        body: onlyTheSecond,
      });

      const after = await bodyNow();
      expect(after).toContain("Burst returns 429 with Retry-After.");
      // Not merely absent: the line it would have replaced is still there.
      expect(after).toContain("Sixty a minute.");
      expect(after).not.toContain("per API key");
      expect(after).toContain("# Rate limiting");
    });

    it("records a rejection and leaves the item alone", async () => {
      const turn = await propose();
      const result = await proposals.rejectProposal(db, asOwner, specId, turn.id);

      expect(await bodyNow()).toBe(ITEM_BODY);
      expect(result.message.proposal!.outcome).toBe("rejected");
      // Kept, not deleted: "we considered this wording and did not take it" is
      // part of how a colleague reconstructs why the spec says what it says.
      const thread = await svc.listAssistantThread(db, asOwner, specId);
      expect(thread).toHaveLength(2);
      expect(thread[1]!.proposal!.outcome).toBe("rejected");
    });

    it("tells the next turn that a proposal was turned down", async () => {
      const turn = await propose();
      await proposals.rejectProposal(db, asOwner, specId, turn.id);
      answerFrames = ["Understood."];
      await ask(asOwner, specId, "Try again.");

      // Without this a rejection is invisible to every later turn: the model
      // reads its own draft in the history, cannot tell it was turned down, and
      // folds it straight back into the next proposal. Watched it happen.
      // Assistant turns only. The system prompt quotes the markers in its own
      // instructions, so searching every message finds that instead and passes
      // whatever the history says.
      const draft = replayedAssistantTurns().find((c) =>
        c.includes("BEGIN PROPOSED SPEC"),
      )!;
      expect(draft).toMatch(/reviewed and not accepted/);
    });

    it("does not annotate a proposal that was accepted", async () => {
      // Its text is the description now, and the description is already in the
      // system prompt. Saying so again is telling the model what it can read.
      const turn = await propose();
      await proposals.acceptProposal(db, asOwner, specId, turn.id);
      answerFrames = ["Understood."];
      await ask(asOwner, specId, "Anything else?");

      expect(
        replayedAssistantTurns().some((c) => c.includes("not accepted")),
      ).toBe(false);
    });

    it("refuses to resolve the same proposal twice", async () => {
      const turn = await propose();
      await proposals.acceptProposal(db, asOwner, specId, turn.id);

      // Two people with the panel open, or one person double-clicking. Applying
      // it again would re-apply text that has since been edited.
      await expect(
        proposals.acceptProposal(db, asOwner, specId, turn.id),
      ).rejects.toThrow(proposals.ProposalSettledError);
      await expect(
        proposals.rejectProposal(db, asOwner, specId, turn.id),
      ).rejects.toThrow(proposals.ProposalSettledError);
    });

    it("applies once when two accepts race", async () => {
      const turn = await propose();
      // The window the sequential check cannot close: two people with the panel
      // open, or one person double-clicking. Both requests read an unresolved
      // proposal, and without an atomic claim both go on to write.
      const results = await Promise.allSettled([
        proposals.acceptProposal(db, asOwner, specId, turn.id),
        proposals.acceptProposal(db, asOwner, specId, turn.id),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await bodyNow()).toBe(NEW_BODY);

      const [row] = await sql<{ n: string }[]>`
        select count(*) as n from assistant_messages
        where id = ${turn.id} and proposal_outcome = 'accepted'`;
      expect(row!.n).toBe("1");
    });

    it("leaves a proposal open when the write it was accepted for fails", async () => {
      const turn = await propose();
      // An empty body is refused before anything is claimed, so the proposal
      // must still be there to act on afterwards. A card marked accepted with
      // nothing applied is the worst of both.
      await expect(
        proposals.acceptProposal(db, asOwner, specId, turn.id, { body: "   " }),
      ).rejects.toThrow(proposals.ProposalInvalidError);

      const thread = await svc.listAssistantThread(db, asOwner, specId);
      expect(thread[1]!.proposal!.outcome).toBeNull();
      expect(await bodyNow()).toBe(ITEM_BODY);
      // And it can still be accepted properly.
      await proposals.acceptProposal(db, asOwner, specId, turn.id);
      expect(await bodyNow()).toBe(NEW_BODY);
    });

    it("refuses someone who can read the item but not change it", async () => {
      const turn = await propose();
      // A workspace member with no role on the product. They can see the item
      // and the conversation; accepting is an edit and edits are not theirs.
      await expect(
        proposals.acceptProposal(db, asOutsider, specId, turn.id),
      ).rejects.toThrow(proposals.ProposalForbiddenError);
      expect(await bodyNow()).toBe(ITEM_BODY);
    });

    it("does not offer proposing to someone who could not accept", async () => {
      const panel = await svc.getAssistantPanelData(db, asOutsider, specId);
      expect(panel.canEdit).toBe(false);

      await ask(asOutsider, specId, "Rewrite this for me.");
      const system = captured.at(-1)!.messages.find((m) => m.role === "system")!.content;
      expect(system).not.toContain("BEGIN PROPOSED SPEC");
      expect(system).toMatch(/no write access|cannot change anything/i);
    });

    it("refuses a message that carries no proposal", async () => {
      const outcome = await ask(asOwner, specId, "Just a question.");
      const turn = outcome.turns![1]!;
      expect(turn.proposal).toBeNull();
      await expect(
        proposals.acceptProposal(db, asOwner, specId, turn.id),
      ).rejects.toThrow(proposals.ProposalInvalidError);
    });

    it("refuses a proposal id that belongs to a different item", async () => {
      const turn = await propose();
      // The message id is real and the caller can write this product; only the
      // item in the URL is wrong. Without matching on both, an id could be
      // resolved through whichever item the caller happens to have access to.
      await expect(
        proposals.acceptProposal(db, asOwner, closedSpecId, turn.id),
      ).rejects.toThrow();
      expect(await bodyNow()).toBe(ITEM_BODY);
    });

    it("carries the whole exchange into the next question", async () => {
      const turn = await propose();
      await proposals.acceptProposal(db, asOwner, specId, turn.id);
      answerFrames = ["Anything else?"];
      await ask(asOwner, specId, "Now what?");

      // The proposal stays in the replayed history as the assistant wrote it.
      // Stripping it would leave the model unable to answer "why did you write
      // it that way", which is the next thing anyone asks.
      expect(
        replayedAssistantTurns().some((c) => c.includes("BEGIN PROPOSED SPEC")),
      ).toBe(true);
      // And the system prompt now carries the accepted text as the description,
      // so the assistant is not still reasoning about the version it replaced.
      expect(captured.at(-1)!.messages[0]!.content).toContain("Return 429.");
    });
  });

  describe("skills", () => {
    let skillsSvc: typeof import("./skills-service");

    beforeAll(async () => {
      skillsSvc = await import("./skills-service");
    });

    beforeEach(async () => {
      await sql`delete from workspace_assistant_skills where workspace_id = ${ws}`;
    });

    it("gives a workspace that has stored nothing the built-in skills", async () => {
      const skills = await skillsSvc.listSkills(db, ws);
      expect(skills.map((s) => s.key)).toContain("grill");
      expect(skills.every((s) => s.builtIn)).toBe(true);
    });

    it("sends a running skill's instructions with the question", async () => {
      await connectStub();
      await ask(asOwner, specId, "", { skillKey: "grill" });

      const system = captured[0]!.messages.find((m) => m.role === "system")!.content;
      expect(system).toContain("Your current task: Grill me");
      // And still everything it sent before: a skill adds to the context, it
      // does not replace it.
      expect(system).toContain("Throttle the public API");
    });

    it("records the skill's own name as the question", async () => {
      await connectStub();
      const outcome = await ask(asOwner, specId, "", { skillKey: "grill" });
      // Not a label the caller supplied: the thread has to say what was actually
      // run, and it is the server that knows.
      expect(outcome.turns![0]!.content).toBe("Grill me");
      expect(outcome.turns![0]!.skillKey).toBe("grill");
    });

    it("keeps the skill in force for the answers that follow", async () => {
      await connectStub();
      await ask(asOwner, specId, "", { skillKey: "grill" });
      // Answering the first question is the moment an interrogation must not
      // quietly turn back into an ordinary chat.
      await ask(asOwner, specId, "Product managers, mostly.", {
        skillKey: "grill",
      });

      const system = captured.at(-1)!.messages.find((m) => m.role === "system")!
        .content;
      expect(system).toContain("Your current task: Grill me");
      const thread = await svc.listAssistantThread(db, asOwner, specId);
      expect(svc.activeSkill(thread)).toBe("grill");
    });

    it("stops running one once a question is asked without it", async () => {
      await connectStub();
      await ask(asOwner, specId, "", { skillKey: "grill" });
      await ask(asOwner, specId, "Unrelated question.");

      const system = captured.at(-1)!.messages.find((m) => m.role === "system")!
        .content;
      expect(system).not.toContain("Your current task");
      expect(svc.activeSkill(await svc.listAssistantThread(db, asOwner, specId)))
        .toBeNull();
    });

    it("runs a workspace's own wording once it overrides a built-in", async () => {
      await connectStub();
      await skillsSvc.replaceSkills(db, ws, [
        {
          key: "grill",
          name: "Interrogate me",
          description: "",
          instructions: "Only ever ask about pricing.",
          enabled: true,
          position: 0,
        },
      ]);
      const outcome = await ask(asOwner, specId, "", { skillKey: "grill" });

      const system = captured[0]!.messages.find((m) => m.role === "system")!.content;
      expect(system).toContain("Only ever ask about pricing.");
      expect(system).not.toContain("Ask the person questions.");
      expect(outcome.turns![0]!.content).toBe("Interrogate me");
    });

    it("refuses a skill that is switched off", async () => {
      await connectStub();
      await skillsSvc.replaceSkills(db, ws, [
        {
          key: "grill",
          name: "Grill me",
          description: "",
          instructions: "x",
          enabled: false,
          position: 0,
        },
      ]);
      await expect(
        ask(asOwner, specId, "", { skillKey: "grill" }),
      ).rejects.toBeInstanceOf(svc.AssistantInputError);
    });

    it("refuses a skill this workspace does not have", async () => {
      await connectStub();
      // A key from somebody else's workspace must not resolve here, and a
      // deleted one must not keep working.
      await expect(
        ask(asOwner, specId, "", { skillKey: "no-such-skill" }),
      ).rejects.toBeInstanceOf(svc.AssistantInputError);
    });

    it("offers the panel only the skills that are switched on", async () => {
      await connectStub();
      await skillsSvc.replaceSkills(db, ws, [
        {
          key: "gaps",
          name: "Find the gaps",
          description: "",
          instructions: "x",
          enabled: false,
          position: 0,
        },
      ]);
      const data = await svc.getAssistantPanelData(db, asOwner, specId);
      expect(data.skills.map((s) => s.key)).not.toContain("gaps");
      expect(data.skills.map((s) => s.key)).toContain("grill");
    });

    it("tells the panel which skill the thread is already running", async () => {
      await connectStub();
      await ask(asOwner, specId, "", { skillKey: "grill" });
      // So reopening the item picks the grilling back up rather than dropping
      // the person into a blank composer whose replies are no longer part of it.
      const data = await svc.getAssistantPanelData(db, asOwner, specId);
      expect(data.activeSkillKey).toBe("grill");
    });

    it("puts the skills in the order a workspace stored", async () => {
      await skillsSvc.replaceSkills(db, ws, [
        { key: "draft", name: null, description: null, instructions: null, enabled: true, position: 0 },
        { key: "grill", name: null, description: null, instructions: null, enabled: true, position: 1 },
        { key: "gaps", name: null, description: null, instructions: null, enabled: true, position: 2 },
      ]);
      const skills = await skillsSvc.listSkills(db, ws);
      expect(skills.map((s) => s.key)).toEqual(["draft", "grill", "gaps"]);
    });

    it("reorders without freezing the wording we ship", async () => {
      // The reason the columns are nullable. A workspace that only rearranged
      // its buttons must go on getting later improvements to these prompts.
      await skillsSvc.replaceSkills(db, ws, [
        { key: "draft", name: null, description: null, instructions: null, enabled: true, position: 0 },
        { key: "grill", name: null, description: null, instructions: null, enabled: true, position: 1 },
      ]);
      const skills = await skillsSvc.listSkills(db, ws);
      const grill = skills.find((s) => s.key === "grill")!;
      const { BUILT_IN_SKILLS } = await import("./ai/skills");
      expect(grill.instructions).toBe(
        BUILT_IN_SKILLS.find((b) => b.key === "grill")!.instructions,
      );
      expect(grill.customised).toBe(false);
    });

    it("stops reporting a skill as running once it is switched off", async () => {
      await connectStub();
      await ask(asOwner, specId, "", { skillKey: "grill" });
      await skillsSvc.replaceSkills(db, ws, [
        {
          key: "grill",
          name: "Grill me",
          description: "",
          instructions: "x",
          enabled: false,
          position: 0,
        },
      ]);

      // Otherwise the panel keeps sending a key the next turn is refused for,
      // and every question the person types fails until they reload.
      const data = await svc.getAssistantPanelData(db, asOwner, specId);
      expect(data.activeSkillKey).toBeNull();
    });

    it("keeps a thread readable after the skill it ran is deleted", async () => {
      await connectStub();
      await skillsSvc.replaceSkills(db, ws, [
        {
          key: "ours",
          name: "Our way",
          description: "",
          instructions: "Do it our way.",
          enabled: true,
          position: 0,
        },
      ]);
      await ask(asOwner, specId, "", { skillKey: "ours" });
      await skillsSvc.replaceSkills(db, ws, []);

      const thread = await svc.listAssistantThread(db, asOwner, specId);
      expect(thread[0]!.content).toBe("Our way");
      expect(thread[0]!.skillKey).toBe("ours");
      // The panel resolves the key to nothing and simply stops showing it as
      // running, rather than failing to load a conversation.
      const data = await svc.getAssistantPanelData(db, asOwner, specId);
      expect(data.skills.some((s) => s.key === "ours")).toBe(false);
    });
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
    /** A second item with an untouched thread; see the note in beforeAll. */
    let rtProposalSpecId: string;

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
      // A second item, so the proposal test starts from an empty thread.
      // Sharing one item made it order-dependent: the streaming test above
      // leaves two turns behind, and a 0.5B model carrying unrelated
      // conversation is markedly worse at holding a required output format. It
      // failed five attempts in a row on a used thread and complied first time
      // on a fresh one. That is worth knowing, and it is a different question
      // from the one this test asks.
      const clean = await store.createFeature(
        { title: "Data retention", level: "epic", productId: rtProduct },
        scope,
      );
      rtProposalSpecId = clean.specId;

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
      "streams from the real model and persists the exchange",
      async () => {
        const turn = await svc.startAssistantTurn(
          db,
          scope,
          rtSpecId,
          "In one sentence, what is the biggest gap in this definition?",
        );
        const deltas: string[] = [];
        let turns: import("./assistant-service").AssistantMessageView[] | null = null;
        let error: unknown = null;
        for await (const event of turn) {
          if (event.kind === "delta") deltas.push(event.text);
          else if (event.kind === "done") turns = event.turns;
          else error = event.error;
        }

        expect(error).toBeNull();
        // The claim streaming actually makes: a real runtime hands the answer
        // over in pieces, not as one block at the end. A stub can be made to
        // do either, so this is the assertion only a real one can settle.
        expect(deltas.length).toBeGreaterThan(1);
        // Not asserted: what it says. A 0.5B model on CPU says whatever it
        // likes, and asserting on content would make this a test of the model
        // rather than of the path to it.
        expect(turns![1]!.content).toBe(deltas.join(""));
        expect(turns![1]!.content.length).toBeGreaterThan(0);
        expect(turns![1]!.model).toBe(RUNTIME_MODEL);

        const thread = await svc.listAssistantThread(db, scope, rtSpecId);
        expect(thread).toHaveLength(2);
        expect(thread[1]!.content).toBe(turns![1]!.content);
      },
      // A small model on CPU is not fast, and the first call loads weights.
      120_000,
    );

    it(
      "can be got to emit a proposal block a real parser reads back",
      async () => {
        // The one claim the stub cannot settle. Proposals are a marker block
        // rather than a tool call precisely because tool calling is the least
        // uniformly implemented part of the OpenAI API and small models emit
        // malformed calls; that argument is only worth anything if a small
        // model can actually produce the block.
        //
        // Several attempts, each from an empty thread, because at 0.5B it is
        // not every time. What was actually measured while writing this: on a
        // fresh thread it complies; carrying a couple of unrelated turns it
        // missed five in a row. Both attempts and the wipe below exist because
        // of that, and the thread has to be cleared *between* attempts or the
        // retries recreate the very condition they are retrying past.
        //
        // A miss is a plain prose answer with the markers left out, which is
        // the degradation this design was chosen for: a worse answer, not a
        // malformed call somebody has to interpret. Missing every attempt is
        // still a real signal and this still fails on it.
        const { parseAnswer } = await import("./ai/proposals");
        const answers: string[] = [];
        let proposal: string | null = null;

        for (let attempt = 0; attempt < 5 && proposal === null; attempt++) {
          await sql`delete from assistant_messages where workspace_id = ${rtWs}`;
          const turn = await svc.startAssistantTurn(
            db,
            scope,
            rtProposalSpecId,
            "Rewrite the description to add a section called Non-goals. " +
              "Reply with the proposal block and nothing else.",
          );
          let answer = "";
          for await (const event of turn) {
            if (event.kind === "delta") answer += event.text;
          }
          answers.push(answer);
          proposal = parseAnswer(answer).proposal;
        }

        // Not asserted: what the proposal says. A 0.5B model writes what it
        // likes and the point here is the envelope, not the content.
        expect(
          proposal,
          `no proposal in ${answers.length} attempts:\n${answers.join("\n---\n")}`,
        ).not.toBeNull();
        expect(proposal).not.toContain("BEGIN PROPOSED SPEC");
      },
      300_000,
    );
  },
);
