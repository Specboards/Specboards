import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@specboards/db";

import { contentVersion } from "@/lib/assistant-service";

// Statically imported, unlike the db-touching modules below: knip treats an
// int test as an entry point but cannot see through `await import()` to which
// named exports a dynamic namespace actually uses, so reaching for these that
// way makes them look dead.
import { reconcile, reconcileStuck } from "./reconcile";

/**
 * What a proposal says while it is being applied, and after a crash.
 *
 * AR-03, the crash-consistency half. `applyProposal` claimed the proposal and
 * then wrote to the target in a separate transaction, and the claim wrote
 * `applied`. A process exit between the two left a row asserting a change
 * that never happened, permanently and invisibly.
 *
 * The window cannot be closed: the write goes through the ordinary human
 * path, which opens its own transaction. What these tests pin is that the row
 * describes the window accurately while it is open, that everything except a
 * killed process closes it, and that a row left open by one is either decided
 * automatically or shown to a person.
 *
 * ── How a crash is simulated ─────────────────────────────────────────────
 * By doing what a crash does rather than by mocking: claim the proposal, then
 * stop. A killed process leaves exactly that, a row in `applying` with no
 * second transaction ever arriving, and a test that reproduces the state is
 * worth more than one that reproduces the mechanism.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const sfx = randomUUID().slice(0, 8);
const ws = randomUUID();
const owner = randomUUID();
const other = randomUUID();
const product = randomUUID();
const runId = randomUUID();

const asOwner = { userId: owner, workspaceId: ws };
const asOther = { userId: other, workspaceId: ws };

const CARD_BODY = "The original description.";
const PROPOSED = "What the agent proposed.";

describe.skipIf(!DB_URL)("a proposal being applied", () => {
  let sql: postgres.Sql;
  let db: Database;
  let service: typeof import("./service");
  let store: typeof import("./store");
  let errors: typeof import("./errors");
  let cardId: string;

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 4 });
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    service = await import("./service");
    store = await import("./store");
    errors = await import("./errors");

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Applying', ${"apply-int-" + sfx})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Owner', ${`owner-${sfx}@ap.test`}),
      (${other}, 'Ada', ${`ada-${sfx}@ap.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner'), (${ws}, ${other}, 'member')`;
    await sql`insert into products (id, workspace_id, key, name, visibility)
      values (${product}, ${ws}, 'alpha', 'Alpha', 'org')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'work', 'Work Items', 0, true)`;
    await sql`insert into product_members (workspace_id, product_id, user_id, role)
      values (${ws}, ${product}, ${other}, 'contributor')`;
    await sql`insert into agent_runs (id, workspace_id, product_id, target_type,
                                      target_id, agent_id, actor_type, trigger,
                                      status, finished_at)
      values (${runId}, ${ws}, ${product}, 'feature', ${randomUUID()},
              ${owner}, 'agent', 'assignment', 'succeeded', now())`;

    cardId = randomUUID();
    await sql`insert into features (id, workspace_id, product_id, spec_id, level,
                                    title, status, details)
      values (${cardId}, ${ws}, ${product}, ${cardId}, 'work', 'A card',
              'backlog', ${CARD_BODY})`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${owner}, ${other})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`delete from proposals where workspace_id = ${ws}`;
    await sql`update features set details = ${CARD_BODY} where id = ${cardId}`;
  });

  async function propose(
    kind: "spec_content" | "item_metadata" = "spec_content",
    payload: unknown = { body: PROPOSED },
  ): Promise<import("./store").ProposalRow> {
    const id = randomUUID();
    await sql`insert into proposals
        (id, workspace_id, product_id, origin, run_id, actor_id, actor_type,
         kind, target_type, target_id, payload, status)
      values (${id}, ${ws}, ${product}, 'run', ${runId}, ${owner}, 'agent',
              ${kind}, 'feature', ${cardId}, ${sql.json(payload as never)}, 'open')`;
    const row = await store.getProposal(db, asOwner, id);
    if (!row) throw new Error("fixture proposal not readable");
    return row;
  }

  const statusOf = async (id: string) =>
    (
      await sql<{ status: string }[]>`
        select status from proposals where id = ${id}`
    )[0]!.status;

  describe("the ordinary path", () => {
    it("ends applied, carrying what the write produced", async () => {
      const row = await propose();
      const decision = await service.applyProposal(db, asOwner, row.id);
      expect(decision.status).toBe("applied");

      const [after] = await sql<{ status: string; result: unknown }[]>`
        select status, result from proposals where id = ${row.id}`;
      expect(after!.status).toBe("applied");
      // Status and result move in one statement, so a row reading `applied`
      // always carries its outcome. They used to be two writes, which left a
      // window where it said a change had landed and could not say what.
      expect(after!.result).not.toBeNull();
    });

    it("refuses a stale proposal without ever claiming it", async () => {
      // Every refusal in `prepare` has to leave the proposal actionable,
      // which is the whole reason the guards run before the claim. Asserted
      // on `resolved_by` as well as the status: a row reset back to `open`
      // and one never claimed look the same from the status alone, and only
      // the second is what this ordering is supposed to produce.
      const row = await propose();
      await sql`update proposals set base_version = ${contentVersion(CARD_BODY)}
                where id = ${row.id}`;
      await sql`update features set details = 'Somebody else typed this.'
                where id = ${cardId}`;

      await expect(
        service.applyProposal(db, asOwner, row.id),
      ).rejects.toBeInstanceOf(errors.ProposalStaleError);

      const [after] = await sql<{ status: string; by: string | null }[]>`
        select status, resolved_by as by from proposals where id = ${row.id}`;
      expect(after!.status).toBe("open");
      expect(after!.by).toBeNull();
    });

    it("puts a claim back, so a failed apply is retryable", async () => {
      // The `catch` in `applyProposal` calls this. Exercised directly because
      // forcing a throw between the claim and the write means forcing a
      // failure inside the human write path, and a test that has to reach
      // that far in is testing the mock rather than the rule.
      const row = await propose();
      await store.claim(db, asOwner, row.id, "applying");
      await store.releaseClaim(db, asOwner, row.id);

      const [after] = await sql<{ status: string; by: string | null; at: Date | null }[]>`
        select status, resolved_by as by, resolved_at as at
        from proposals where id = ${row.id}`;
      expect(after!.status).toBe("open");
      expect(after!.by).toBeNull();
      expect(after!.at).toBeNull();
    });
  });

  describe("after a crash mid-apply", () => {
    /** Exactly what a killed process leaves: claimed, and then nothing. */
    async function crashAfterClaim(id: string) {
      const claimed = await store.claim(db, asOwner, id, "applying");
      expect(claimed).not.toBeNull();
    }

    it("does not claim the change was applied", async () => {
      // The defect in one line. This used to read `applied`.
      const row = await propose();
      await crashAfterClaim(row.id);
      expect(await statusOf(row.id)).toBe("applying");

      // And the target really was not touched, so `applied` would have been
      // a lie rather than merely premature.
      const [card] = await sql<{ details: string }[]>`
        select details from features where id = ${cardId}`;
      expect(card!.details).toBe(CARD_BODY);
    });

    it("tells the next person the outcome is unknown, not that it is done", async () => {
      const row = await propose();
      await crashAfterClaim(row.id);
      await expect(service.applyProposal(db, asOther, row.id)).rejects.toThrow(
        /started applying this proposal and it has not finished/i,
      );
    });

    it("still refuses a second claim, so nothing writes twice", async () => {
      const row = await propose();
      await crashAfterClaim(row.id);
      expect(await store.claim(db, asOther, row.id, "applying")).toBeNull();
    });
  });

  describe("reconciling what was left behind", () => {
    const AGES_AGO = () => new Date(Date.now() + 10 * 60 * 1000);

    it("settles a text proposal whose target holds the proposed text", async () => {
      // The write DID land and the process died before recording it. The
      // target is the evidence, and it is conclusive here: an apply is
      // refused unless the target still matches the base the draft was made
      // against, so the target holding the proposed text means this proposal
      // put it there.
      const row = await propose();
      await store.claim(db, asOwner, row.id, "applying");
      await sql`update features set details = ${PROPOSED} where id = ${cardId}`;

      const fresh = (await store.getProposal(db, asOwner, row.id))!;
      expect(await reconcile(db, asOwner, fresh, AGES_AGO())).toEqual({
        outcome: "applied",
      });
      expect(await statusOf(row.id)).toBe("applied");
    });

    it("leaves one alone when the target does not hold the proposed text", async () => {
      const row = await propose();
      await store.claim(db, asOwner, row.id, "applying");

      const fresh = (await store.getProposal(db, asOwner, row.id))!;
      const verdict = await reconcile(db, asOwner, fresh, AGES_AGO());
      expect(verdict.outcome).toBe("undecidable");
      expect(await statusOf(row.id)).toBe("applying");
    });

    it("refuses to guess about a metadata change set", async () => {
      // An item at `ready` after a proposal to move it to `ready` may have
      // been moved by the proposal or by a person. Settling it would put a
      // name against a decision somebody did not make.
      const row = await propose("item_metadata", { status: "ready" });
      await store.claim(db, asOwner, row.id, "applying");
      await sql`update features set status = 'ready' where id = ${cardId}`;

      const fresh = (await store.getProposal(db, asOwner, row.id))!;
      const verdict = await reconcile(db, asOwner, fresh, AGES_AGO());
      expect(verdict.outcome).toBe("undecidable");
      // The REASON, not just the verdict. Without the kind check this row
      // falls through to the text comparison, its payload fails to parse,
      // and "undecidable" comes back anyway: the right answer reached by an
      // accident that would stop holding the moment a change set grew a
      // readable `body`. Pinning the reason is what makes this a test of the
      // rule rather than of the parser.
      expect(verdict).toMatchObject({
        why: expect.stringContaining("told apart"),
      });
      expect(await statusOf(row.id)).toBe("applying");
    });

    it("does not touch an apply that is merely still in flight", async () => {
      // The grace period. Reconciling eagerly would race a live request and
      // could settle a row whose write is about to fail.
      const row = await propose();
      await store.claim(db, asOwner, row.id, "applying");
      await sql`update features set details = ${PROPOSED} where id = ${cardId}`;

      const fresh = (await store.getProposal(db, asOwner, row.id))!;
      // "Now" rather than ten minutes on: the claim is seconds old.
      expect(await reconcile(db, asOwner, fresh)).toEqual({
        outcome: "in_flight",
      });
      expect(await statusOf(row.id)).toBe("applying");
    });

    it("sweeps the queue, deciding only what it can", async () => {
      const decidable = await propose();
      const not = await propose("item_metadata", { status: "ready" });
      await store.claim(db, asOwner, decidable.id, "applying");
      await store.claim(db, asOwner, not.id, "applying");
      await sql`update features set details = ${PROPOSED} where id = ${cardId}`;
      // Age both claims past the grace period.
      await sql`update proposals set updated_at = now() - interval '10 minutes'
                where workspace_id = ${ws}`;

      await reconcileStuck(db, asOwner);
      expect(await statusOf(decidable.id)).toBe("applied");
      expect(await statusOf(not.id)).toBe("applying");
    });
  });

  describe("the claim guards", () => {
    it("does not let a release reopen a proposal it did not claim", async () => {
      // `releaseClaim` was an unconditional reset by id. Harmless while its
      // only caller was the failing request itself, and a way to reopen
      // somebody's applied proposal the moment it was not.
      const row = await propose();
      await service.applyProposal(db, asOwner, row.id);
      expect(await statusOf(row.id)).toBe("applied");

      await store.releaseClaim(db, asOwner, row.id);
      expect(await statusOf(row.id)).toBe("applied");
    });

    it("does not settle a proposal that is no longer applying", async () => {
      const row = await propose();
      expect(await store.settle(db, asOwner, row.id, { body: "x" })).toBe(false);
      expect(await statusOf(row.id)).toBe("open");
    });
  });
});
