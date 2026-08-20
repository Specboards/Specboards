import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Drafting a release's notes, against a real database.
 *
 * Structured like `assistant.int.test.ts` and for the same reasons. Most of it
 * drives a **stub** OpenAI-compatible server, because the claims worth pinning
 * are about what Specboards sends, what it refuses, and what it spends, and only
 * a server we control can be asked what it received. One test at the end drives
 * a **real** runtime when one is configured, so the end-to-end claim ("pressing
 * the button reaches a model and notes come back") rests on something other than
 * a server written by the same person as the assertions.
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
const user = { owner: randomUUID(), viewer: randomUUID() };
const openProduct = randomUUID();
const closedProduct = randomUUID();

const asOwner = { userId: user.owner, workspaceId: ws };
const asViewer = { userId: user.viewer, workspaceId: ws };

interface CapturedRequest {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens?: number;
  stream?: boolean;
}

describe.skipIf(!DB_URL)("drafting a release's notes", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let svc: typeof import("./release-notes-service");
  let providers: typeof import("./model-provider-service");
  let proposals: typeof import("./assistant-proposals");
  let assistant: typeof import("./assistant-service");
  let server: Server;
  let endpoint: string;
  /** A release with work in it, in a product everyone can read. */
  let releaseId: string;
  /** A release nothing is scheduled into. */
  let emptyReleaseId: string;
  /** A portfolio release (no product) holding work from the private product. */
  let portfolioReleaseId: string;
  /** The item in the product a plain member cannot see. */
  let secretSpecId: string;

  let captured: CapturedRequest[] = [];
  let slow = false;
  let disconnected = false;
  let answerFrames = ["## Highlights\n", "- Single sign-on is here.\n"];
  /** Set by tests that need the thread cleared between turns. */
  const wipeThread = async () =>
    sql`delete from assistant_messages where workspace_id = ${ws}`;

  /**
   * Run a turn to completion, collecting what a caller would observe.
   *
   * The production path is a stream, so the tests drive the stream. Draining it
   * here rather than keeping a second non-streaming entry point means there is
   * one implementation of "what gets persisted" instead of two that have to be
   * kept in agreement.
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
    const turn = await svc.startReleaseTurn(db, scope, id, text, opts);
    const deltas: string[] = [];
    let turns: import("./assistant-service").AssistantMessageView[] | null = null;
    let error: { kind: string; message: string } | null = null;
    for await (const event of turn) {
      if (event.kind === "delta") {
        deltas.push(event.text);
        opts.onDelta?.(event.text);
      } else if (event.kind === "done") turns = event.turns;
      else error = event.error;
    }
    return { deltas, text: deltas.join(""), turns, error };
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    svc = await import("./release-notes-service");
    providers = await import("./model-provider-service");
    proposals = await import("./assistant-proposals");
    assistant = await import("./assistant-service");

    // A streaming stub, in frames, so reassembly is a real assertion.
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        if (!req.url?.endsWith("/chat/completions")) {
          res.writeHead(404).end();
          return;
        }
        captured.push(JSON.parse(body) as CapturedRequest);

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const frame = (payload: unknown) =>
          res.write(`data: ${JSON.stringify(payload)}\n\n`);

        let hungUp = false;
        res.on("close", () => {
          hungUp = true;
          // Only an early close is a client hanging up; a finished response
          // emits `close` too, and counting that would make the cancel
          // assertion pass for free.
          if (!res.writableFinished) disconnected = true;
        });

        for (const part of answerFrames) {
          if (hungUp) return;
          frame({ model: "stub-model-v1", choices: [{ delta: { content: part } }] });
          if (slow) await new Promise((r) => setTimeout(r, 300));
        }
        if (hungUp) return;
        frame({
          model: "stub-model-v1",
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 44, completion_tokens: 9, total_tokens: 53 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Notes', ${`notes-${suffix}`})`;
    await sql`insert into users (id, name, email) values
      (${user.owner}, 'Ada', ${`ada-${suffix}@notes.test`}),
      (${user.viewer}, 'Vic', ${`vic-${suffix}@notes.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.viewer}, 'member')`;
    await sql`insert into products (id, workspace_id, key, name, visibility) values
      (${openProduct}, ${ws}, 'alpha', 'Alpha', 'org'),
      (${closedProduct}, ${ws}, 'secret', 'Secret', 'private')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;

    const { getStore } = await import("./store");
    const store = await getStore();

    const release = await store.createRelease(
      { name: `v9.1.0-${suffix}`, productId: openProduct, targetDate: "2026-09-01" },
      asOwner,
    );
    releaseId = release.id;
    const empty = await store.createRelease(
      { name: `v9.2.0-${suffix}`, productId: openProduct },
      asOwner,
    );
    emptyReleaseId = empty.id;
    const portfolio = await store.createRelease(
      { name: `v9.3.0-${suffix}`, productId: null },
      asOwner,
    );
    portfolioReleaseId = portfolio.id;

    const sso = await store.createFeature(
      {
        title: "Single sign-on",
        level: "epic",
        productId: openProduct,
        details: "SAML and OIDC.",
      },
      asOwner,
    );
    await store.updateFeature(sso.specId, { releaseId }, asOwner);

    const upload = await store.createFeature(
      { title: "SAML metadata upload", level: "story", productId: openProduct },
      asOwner,
    );
    await store.updateFeature(upload.specId, { releaseId }, asOwner);

    // Work in a product the viewer cannot see, scheduled into the portfolio
    // release. The whole point of the visibility assertion below.
    const secret = await store.createFeature(
      {
        title: "Acquisition tooling",
        level: "epic",
        productId: closedProduct,
        details: "Confidential: diligence workflow.",
      },
      asOwner,
    );
    secretSpecId = secret.specId;
    await store.updateFeature(
      secret.specId,
      { releaseId: portfolioReleaseId },
      asOwner,
    );
  });

  beforeEach(async () => {
    captured = [];
    slow = false;
    disconnected = false;
    answerFrames = ["## Highlights\n", "- Single sign-on is here.\n"];
    await sql`delete from model_providers where workspace_id = ${ws}`;
    await sql`delete from model_provider_credentials where workspace_id = ${ws}`;
    await sql`delete from model_usage_events where workspace_id = ${ws}`;
    await sql`delete from assistant_messages where workspace_id = ${ws}`;
    await sql`update releases set release_notes_mode = 'none', release_notes_body = null
      where workspace_id = ${ws}`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${user.owner}, ${user.viewer})`;
    await sql.end({ timeout: 5 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE;
  });

  async function connectStub() {
    await providers.saveModelProvider(db, ws, {
      baseUrl: endpoint,
      model: "stub-model",
      apiKey: "sk-stub-key-0001",
    });
  }

  it("streams a draft built from the work in the release", async () => {
    await connectStub();
    const outcome = await ask(asOwner, releaseId, "Draft the notes.");

    expect(outcome.error).toBeNull();
    // Delivered in pieces, and reassembled into the draft the editor holds.
    expect(outcome.deltas.length).toBeGreaterThan(1);
    expect(outcome.text).toBe("## Highlights\n- Single sign-on is here.\n");
    expect(outcome.turns).toHaveLength(2);
    expect(outcome.turns![0]!.role).toBe("user");
    expect(outcome.turns![1]!.content).toBe(outcome.text);
  });

  it("persists nothing", async () => {
    await connectStub();
    await ask(asOwner, releaseId, "Draft the notes.");

    // The hard constraint of this feature. The draft lands in an editor and a
    // person saves it, or does not.
    const [row] = await sql<{ mode: string; body: string | null }[]>`
      select release_notes_mode as mode, release_notes_body as body
      from releases where id = ${releaseId}`;
    expect(row!.mode).toBe("none");
    expect(row!.body).toBeNull();
  });

  it("sends the release, its items and their descriptions", async () => {
    await connectStub();
    await ask(asOwner, releaseId, "Draft the notes.");

    const system = captured[0]!.messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("Single sign-on");
    expect(system).toContain("SAML metadata upload");
    expect(system).toContain("Epics"); // the workspace's own level label
    // The descriptions, which is what customers asked for: from titles alone a
    // model has to guess what "Single sign-on" meant for a customer, and
    // guessing is how an invented release note gets written.
    expect(system).toContain("SAML and OIDC.");
  });

  it("sends nothing about the people involved", async () => {
    await connectStub();
    await ask(asOwner, releaseId, "Draft the notes.");
    const system = captured[0]!.messages.find((m) => m.role === "system")!.content;
    // Names and addresses are not ours to hand to a third-party endpoint on our
    // own initiative, and knowing who built something does not make the notes
    // better. Still true now that the bodies go too: those are the customer's
    // own text, and what is in them is their decision.
    expect(system).not.toContain("Ada");
    expect(system).not.toContain("@notes.test");
  });

  it("sends the internal planning notes to nobody", async () => {
    await connectStub();
    await sql`update releases set notes = 'Slipping because the vendor is late.'
      where id = ${releaseId}`;
    await ask(asOwner, releaseId, "Draft the notes.");
    const system = captured[0]!.messages.find((m) => m.role === "system")!.content;
    // `releases.notes` is where a team writes things they would never publish,
    // and this is the one surface whose output is customer-facing.
    expect(system).not.toContain("vendor is late");
    await sql`update releases set notes = null where id = ${releaseId}`;
  });

  it("leaves out the body of an item the caller cannot read", async () => {
    await connectStub();
    // The private product's item is in the portfolio release. Its title is
    // already scoped by `listFeatures`; this asserts the bulk body read applies
    // the same decision, so the drafter is not a way to read spec content out
    // of a product you cannot open.
    const bodies = await (await import("./store")).getStore();
    const map = await bodies.listFeatureBodies([secretSpecId], asViewer);
    expect(map.has(secretSpecId)).toBe(false);
    const asOwnerMap = await bodies.listFeatureBodies([secretSpecId], asOwner);
    expect(asOwnerMap.get(secretSpecId)).toContain("Confidential");
  });

  it("asks the endpoint to stream, under a bounded length", async () => {
    await connectStub();
    await ask(asOwner, releaseId, "Draft the notes.");
    expect(captured[0]!.stream).toBe(true);
    // Bounded, so a model that decides to write an essay stops.
    expect(captured[0]!.max_tokens).toBe(svc.ANSWER_MAX_TOKENS);
  });

  it("hides a release the caller cannot see behind a not-found", async () => {
    await connectStub();
    await expect(ask(asOwner, randomUUID(), "Hello?")).rejects.toThrow(/not found/i);
  });

  it("refuses a member with no write access to the product", async () => {
    await connectStub();
    // A workspace member with no grant on this product. Drafting spends money,
    // so it is gated on being able to save the result, not on being able to
    // read the release.
    await expect(ask(asViewer, releaseId, "Hello?")).rejects.toThrow(/permission/i);
    expect(captured).toHaveLength(0);
  });

  it("leaves out work the caller cannot read on a portfolio release", async () => {
    await connectStub();
    // The owner can see it, so the release is draftable and names the item.
    const outcome = await ask(asOwner, portfolioReleaseId, "Draft the notes.");
    expect(outcome.error).toBeNull();
    expect(captured[0]!.messages[0]!.content).toContain("Acquisition tooling");

    // The viewer cannot, so from where they stand the release holds nothing,
    // and the drafter is not a way to read titles out of a product they cannot
    // open. (They are refused for want of write access first; this asserts the
    // item list itself is scoped, by asking as a member of no product.)
    await expect(ask(asViewer, portfolioReleaseId, "Hello?")).rejects.toThrow();
  });

  it("says a model is not connected rather than failing", async () => {
    const outcome = await ask(asOwner, releaseId, "Draft the notes.");
    expect(outcome.error?.kind).toBe("not_configured");
    expect(outcome.error?.message).toMatch(/no model is connected/i);
  });

  it("records what the draft cost, attributed to its own feature", async () => {
    await connectStub();
    await ask(asOwner, releaseId, "Draft the notes.");

    const [row] = await sql<
      {
        feature: string;
        user_id: string;
        prompt_tokens: number;
        completion_tokens: number;
        outcome: string;
      }[]
    >`select feature, user_id, prompt_tokens, completion_tokens, outcome
        from model_usage_events where workspace_id = ${ws}`;
    // Its own label rather than assistant_turn, so a workspace reading its
    // usage can tell drafting notes apart from asking about items.
    expect(row!.feature).toBe("release_notes_draft");
    expect(row!.user_id).toBe(user.owner);
    expect(row!.prompt_tokens).toBe(44);
    expect(row!.completion_tokens).toBe(9);
    expect(row!.outcome).toBe("ok");
  });

  describe("proposals", () => {
    const withProposal = [
      "Tightened the opening.\n",
      "<<<BEGIN PROPOSED SPEC>>>\n",
      "## Highlights\n\nSingle sign-on is here.\n",
      "<<<END PROPOSED SPEC>>>\n",
    ];

    it("applies an accepted proposal to the release's notes", async () => {
      await connectStub();
      answerFrames = withProposal;
      const outcome = await ask(asOwner, releaseId, "Draft the notes.");
      const messageId = outcome.turns![1]!.id;
      expect(outcome.turns![1]!.proposal).not.toBeNull();

      // Nothing has landed yet: a proposal is inert text until somebody says so.
      const [before] = await sql<{ body: string | null }[]>`
        select release_notes_body as body from releases where id = ${releaseId}`;
      expect(before!.body).toBeNull();

      const result = await proposals.acceptReleaseProposal(
        db,
        asOwner,
        releaseId,
        messageId,
      );
      expect(result.body).toBe("## Highlights\n\nSingle sign-on is here.");

      const [after] = await sql<{ body: string; mode: string }[]>`
        select release_notes_body as body, release_notes_mode as mode
        from releases where id = ${releaseId}`;
      expect(after!.body).toBe("## Highlights\n\nSingle sign-on is here.");
      // Accepting switches the notes on. Applying the text and showing nothing
      // would read as the accept having failed.
      expect(after!.mode).toBe("in_app");
    });

    it("takes the reviewer's own wording when they edited before accepting", async () => {
      await connectStub();
      answerFrames = withProposal;
      const outcome = await ask(asOwner, releaseId, "Draft the notes.");
      await proposals.acceptReleaseProposal(
        db,
        asOwner,
        releaseId,
        outcome.turns![1]!.id,
        { body: "## What changed\n\nYou can now use SSO." },
      );
      const [row] = await sql<{ body: string }[]>`
        select release_notes_body as body from releases where id = ${releaseId}`;
      expect(row!.body).toBe("## What changed\n\nYou can now use SSO.");
    });

    it("writes nothing when a proposal is turned down", async () => {
      await connectStub();
      answerFrames = withProposal;
      const outcome = await ask(asOwner, releaseId, "Draft the notes.");
      await proposals.rejectReleaseProposal(
        db,
        asOwner,
        releaseId,
        outcome.turns![1]!.id,
      );
      const [row] = await sql<{ body: string | null }[]>`
        select release_notes_body as body from releases where id = ${releaseId}`;
      expect(row!.body).toBeNull();
    });

    it("lets only the first of two clicks decide", async () => {
      await connectStub();
      answerFrames = withProposal;
      const outcome = await ask(asOwner, releaseId, "Draft the notes.");
      const messageId = outcome.turns![1]!.id;
      await proposals.acceptReleaseProposal(db, asOwner, releaseId, messageId);
      // Two people with the flyout open, or one person double-clicking.
      await expect(
        proposals.acceptReleaseProposal(db, asOwner, releaseId, messageId),
      ).rejects.toThrow(/already/i);
    });

    it("refuses an accept when the notes were edited while the model was writing", async () => {
      // The window this closes: somebody presses "Draft the notes", and while
      // the answer is streaming a colleague saves an edit in the app. The
      // proposal was written without sight of that edit, so accepting it must
      // be refused rather than silently replacing the edit.
      //
      // The base used to be re-read AFTER the stream, which recorded the
      // colleague's edit as though the model had been shown it. The staleness
      // check then compared that text against itself, matched, and applied the
      // proposal over the top. This is the same failure #286 refuses on the item
      // path.
      await connectStub();
      answerFrames = withProposal;

      const lateEdit = "## Written by a human\n\nWhile the model was talking.";
      const turn = await svc.startReleaseTurn(
        db,
        asOwner,
        releaseId,
        "Draft the notes.",
      );

      let edited = false;
      let turns: import("./assistant-service").AssistantMessageView[] | null = null;
      for await (const event of turn) {
        if (event.kind === "delta" && !edited) {
          edited = true;
          // Awaited inside the loop, so the generator is genuinely suspended
          // mid-stream while this lands. No timing assumption.
          await sql`update releases set release_notes_body = ${lateEdit}
            where id = ${releaseId}`;
        }
        if (event.kind === "done") turns = event.turns;
      }
      expect(edited).toBe(true);

      const messageId = turns![1]!.id;
      const [row] = await sql<{ base: string | null }[]>`
        select proposal_base_sha as base from assistant_messages where id = ${messageId}`;
      // The notes were empty when the prompt was built, so that is the base.
      // Recording the late edit here is the bug: it would make the check below
      // pass and the edit disappear.
      expect(row!.base).not.toBeNull();
      expect(row!.base).not.toBe(assistant.contentVersion(lateEdit));

      await expect(
        proposals.acceptReleaseProposal(db, asOwner, releaseId, messageId),
      ).rejects.toThrow(/changed after the assistant drafted this/i);

      // And the human's edit is still there, which is the whole point.
      const [after] = await sql<{ body: string }[]>`
        select release_notes_body as body from releases where id = ${releaseId}`;
      expect(after!.body).toBe(lateEdit);
    });

    it("refuses a message id from another release's thread", async () => {
      await connectStub();
      answerFrames = withProposal;
      const outcome = await ask(asOwner, releaseId, "Draft the notes.");
      // Resolved by release as well as by id, so a thread cannot be reached
      // through a different release the caller happens to be able to write.
      await expect(
        proposals.acceptReleaseProposal(
          db,
          asOwner,
          emptyReleaseId,
          outcome.turns![1]!.id,
        ),
      ).rejects.toThrow(/no longer here/i);
    });
  });

  it("replays the conversation so far on the next question", async () => {
    await connectStub();
    await ask(asOwner, releaseId, "First question.");
    await ask(asOwner, releaseId, "Second question.");
    const second = captured[1]!.messages;
    expect(second.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("refuses a skill written for the item panel", async () => {
    await connectStub();
    // Its instructions are about a different subject entirely, and running them
    // here produces a confident answer about something not on the screen.
    await expect(
      ask(asOwner, releaseId, "", { skillKey: "grill" }),
    ).rejects.toThrow(/does not apply to a release/i);
    expect(captured).toHaveLength(0);
  });

  it("records the release skill it ran on the question", async () => {
    await connectStub();
    const outcome = await ask(asOwner, releaseId, "", {
      skillKey: "release-notes",
    });
    // The skill's own name becomes the question, so the thread reads as one.
    expect(outcome.turns![0]!.content).toBe("Draft the notes");
    expect(outcome.turns![0]!.skillKey).toBe("release-notes");
    expect(captured[0]!.messages[0]!.content).toContain("Your current task");
  });

  it("stops at the provider when the reader goes away", async () => {
    await connectStub();
    slow = true;
    const controller = new AbortController();

    const outcome = await ask(asOwner, releaseId, "Draft the notes.", {
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });

    // Nothing is persisted: a half-sentence in a thread is replayed as context
    // into every later question and drags the answers with it. What must not
    // happen is the connection staying open, billing tokens nobody reads.
    expect(outcome.turns).toBeNull();
    expect(disconnected).toBe(true);
  });
});

// ── Against a real runtime ──────────────────────────────────────────────────

const RUNTIME_URL = process.env.SPECBOARDS_TEST_MODEL_URL;
const RUNTIME_MODEL = process.env.SPECBOARDS_TEST_MODEL ?? "qwen2.5:0.5b";

const rtSuffix = randomUUID().slice(0, 8);
const rtWs = randomUUID();
const rtUser = randomUUID();
const rtProduct = randomUUID();
const rtScope = { userId: rtUser, workspaceId: rtWs };

describe.skipIf(!DB_URL || !RUNTIME_URL)(
  "drafting against a real runtime",
  () => {
    let sql: postgres.Sql;
    let db: import("@specboards/db").Database;
    let svc: typeof import("./release-notes-service");
    let rtReleaseId: string;

    beforeAll(async () => {
      process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
      const { createDb } = await import("@specboards/db");
      db = createDb(DB_URL!);
      svc = await import("./release-notes-service");
      const providers = await import("./model-provider-service");

      sql = postgres(DB_URL!, { prepare: false, max: 2 });
      await sql`insert into workspaces (id, name, slug)
        values (${rtWs}, 'Runtime notes', ${`rtn-${rtSuffix}`})`;
      await sql`insert into users (id, name, email)
        values (${rtUser}, 'Grace', ${`grace-${rtSuffix}@notes.test`})`;
      await sql`insert into members (workspace_id, user_id, role)
        values (${rtWs}, ${rtUser}, 'owner')`;
      await sql`insert into products (id, workspace_id, key, name)
        values (${rtProduct}, ${rtWs}, 'alpha', 'Alpha')`;
      await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
        values (${rtWs}, 'epic', 'Epics', 0, false), (${rtWs}, 'story', 'Stories', 1, true)`;

      const { getStore } = await import("./store");
      const store = await getStore();
      const release = await store.createRelease(
        { name: `v1.0.0-${rtSuffix}`, productId: rtProduct, targetDate: "2026-09-01" },
        rtScope,
      );
      rtReleaseId = release.id;

      for (const [title, details] of [
        [
          "Single sign-on with SAML",
          "Admins upload their identity provider's metadata XML in Settings. After that everyone in the workspace signs in through their company login instead of a password, and leavers lose access when IT disables them centrally.",
        ],
        [
          "Bulk CSV export of reports",
          "A download button on any report writes every row to CSV, not just the page on screen. Previously people copied out of the table by hand and lost anything past the first fifty rows.",
        ],
        [
          "Dark mode",
          "Follows the operating system setting, with a manual override in the profile menu.",
        ],
      ]) {
        const item = await store.createFeature(
          { title: title!, level: "epic", productId: rtProduct, details: details! },
          rtScope,
        );
        await store.updateFeature(item.specId, { releaseId: rtReleaseId }, rtScope);
      }

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
      "streams real release notes from a real model",
      async () => {
        const stream = await svc.startReleaseTurn(db, rtScope, rtReleaseId, "Draft the release notes.");
        const deltas: string[] = [];
        let turns: import("./assistant-service").AssistantMessageView[] | null = null;
        let error: unknown = null;
        for await (const event of stream) {
          if (event.kind === "delta") deltas.push(event.text);
          else if (event.kind === "done") turns = event.turns;
          else error = event.error;
        }

        expect(error).toBeNull();
        // The claim streaming actually makes: a real runtime hands the draft
        // over in pieces. A stub can be made to do either.
        expect(deltas.length).toBeGreaterThan(1);
        expect(turns).toHaveLength(2);

        const notes = deltas.join("");
        expect(notes.length).toBeGreaterThan(0);
        // Not asserted: the prose. A 0.5B model on CPU writes what it likes,
        // and asserting on wording would make this a test of the model rather
        // than of the path to it. What IS asserted is that the release's own
        // work reached it, which is the whole point of the context assembler:
        // a draft that mentions none of the three items came from somewhere
        // other than this release.
        expect(notes.toLowerCase()).toMatch(
          /sign-on|sign on|saml|export|csv|dark mode/,
        );
      },
      120_000,
    );
  },
);
