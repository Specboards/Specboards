import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Database } from "@specboards/db";

import { recordSpecWrite } from "./spec-write-audit";

/**
 * The product's own record of spec writes.
 *
 * What earns this table its place is the row git cannot have: a write that was
 * refused or failed. Someone asking "why is the change I remember making not
 * there" is asking exactly about a commit that never happened, and git has no
 * record of one.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const wsId = randomUUID();
const userId = randomUUID();
const specId = randomUUID();
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!OWNER_URL)("recordSpecWrite", () => {
  let owner: postgres.Sql;
  let db: Database;

  const rows = () =>
    owner`select * from spec_write_audit where workspace_id = ${wsId} order by created_at`;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);
    await owner`insert into workspaces (id, name, slug) values
      (${wsId}, 'Audit', ${"audit-int-" + suffix})`;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${wsId}`;
    await owner.end({ timeout: 5 });
  });

  it("records a refusal, which git has no way to answer", async () => {
    await recordSpecWrite(db, {
      workspaceId: wsId,
      actorId: userId,
      specId,
      path: "specs/refunds/spec.md",
      action: "update",
      outcome: "refused",
      attribution: "none",
      detail: "Your role does not permit editing this spec.",
    });
    const [row] = await rows();
    expect(row!.outcome).toBe("refused");
    // The reason, in the words the author was shown. Six weeks later that is
    // an answer; "no" on its own is not.
    expect(row!.detail).toContain("does not permit");
    expect(row!.commit_sha).toBeNull();
  });

  it("distinguishes a change committed as its author from one merely credited", async () => {
    await recordSpecWrite(db, {
      workspaceId: wsId,
      specId,
      path: "p.md",
      action: "update",
      outcome: "committed",
      attribution: "author",
      commitSha: "abc1234",
    });
    await recordSpecWrite(db, {
      workspaceId: wsId,
      specId,
      path: "p.md",
      action: "update",
      outcome: "committed",
      attribution: "co_author",
      commitSha: "def5678",
    });
    const all = await rows();
    const kinds = all.map((r) => r.attribution);
    // Without this column, a repo full of app-authored commits looks identical
    // whether attribution is working or has quietly stopped.
    expect(kinds).toContain("author");
    expect(kinds).toContain("co_author");
  });

  it("keeps a proposal's number so the review can be found later", async () => {
    await recordSpecWrite(db, {
      workspaceId: wsId,
      specId,
      path: "p.md",
      action: "update",
      outcome: "proposed",
      attribution: "co_author",
      pullRequestNumber: 482,
    });
    const all = await rows();
    expect(all.at(-1)!.pull_request_number).toBe(482);
  });

  it("bounds the detail rather than storing a wall of text", async () => {
    await recordSpecWrite(db, {
      workspaceId: wsId,
      path: "p.md",
      action: "create",
      outcome: "failed",
      attribution: "none",
      detail: "x".repeat(5000),
    });
    // A stack trace in an audit row makes the rows around it unreadable, which
    // defeats the point of the table.
    expect((await rows()).at(-1)!.detail!.length).toBeLessThanOrEqual(500);
  });

  it("never throws, so a broken audit cannot fail an author's save", async () => {
    await expect(
      recordSpecWrite(db, {
        // A workspace that does not exist violates the foreign key.
        workspaceId: randomUUID(),
        path: "p.md",
        action: "update",
        outcome: "committed",
        attribution: "none",
      }),
    ).resolves.toBeUndefined();
  });

  it("goes when its workspace goes", async () => {
    const doomed = randomUUID();
    await owner`insert into workspaces (id, name, slug) values
      (${doomed}, 'Doomed', ${"doomed-int-" + suffix})`;
    await recordSpecWrite(db, {
      workspaceId: doomed,
      path: "p.md",
      action: "update",
      outcome: "committed",
      attribution: "none",
    });
    await owner`delete from workspaces where id = ${doomed}`;
    expect(
      await owner`select id from spec_write_audit where workspace_id = ${doomed}`,
    ).toHaveLength(0);
  });
});
