import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What the public Ideas portal's reader can and cannot see.
 *
 * The portal serves people with no account, so it cannot use `specboards_app`
 * (whose policies key on `app.user_id` and match nothing for a stranger) and
 * must not use the owner connection (which bypasses RLS, making one forgotten
 * WHERE clause the difference between a public portal and an unannounced
 * product's backlog on a public URL). It reads as `specboards_portal`, whose
 * policies carry the publication rule itself.
 *
 * That makes the database a second, independent statement of the visibility
 * rules. These cases are what stop it drifting into being a first-and-only one
 * that nobody checks: every assertion here is about a row that EXISTS and must
 * not come back, which is the only kind of bug this design exists to prevent
 * and the only kind that a passing portal page would never reveal.
 *
 * ── What these cases can and cannot fail on ────────────────────────────────
 * Checked by mutation rather than assumed, because a security test that cannot
 * fail is worse than none: it is the same blind spot
 * `owner-connection-rls.int.test.ts` records about its own fixture, where
 * `beforeAll` replays the very grants the assertions then check for.
 *
 * - A WRONG PREDICATE is caught. Replacing `specboards_portal_shows_idea` with
 *   `SELECT true` fails two cases, and the first one fails by listing another
 *   workspace's idea, which is the failure worth having.
 * - A HAND-EDITED POLICY on a live database is NOT caught, and cannot be here.
 *   `beforeAll` replays `portal-role.sql`, which calls
 *   `specboards_portal_apply_grants()` and so rewrites every policy to the
 *   committed definition before a single assertion runs. Loosening
 *   `ideas_portal_select` to `USING (true)` by hand is silently undone and all
 *   seven still pass.
 *
 * The replay is not removable: on a fresh database the migration runs before
 * the role exists and skips its grants, so without it there would be no role to
 * connect as. What this file therefore asserts is that the SQL in the
 * repository is correct, which is the question CI can answer (it migrates from
 * scratch every run). Whether a live cluster still matches that SQL is a
 * different question, and `psql` against test and prod is the way to ask it.
 *
 * Needs a migrated Postgres at DATABASE_URL and rights to create a role; skips
 * itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const openWs = randomUUID();
const shutWs = randomUUID();
const shownProduct = randomUUID();
const unannouncedProduct = randomUUID();
const shutProduct = randomUUID();
const publishedIdea = randomUUID();
const declinedIdea = randomUUID();
const unannouncedIdea = randomUUID();
const shutIdea = randomUUID();
const roadmapItem = randomUUID();
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!DB_URL)("row-level security on the portal connection", () => {
  let sql: postgres.Sql;

  /** Read as the portal does: no user, no scope, just the role. */
  async function asPortal<T>(
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`set local role specboards_portal`;
      return fn(tx);
    }) as Promise<T>;
  }

  const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    // Replay provisioning, which also applies the grants and policies via
    // `specboards_portal_apply_grants()`. Both this file and the migration call
    // that same function, which is the point: a fresh database (migration runs
    // before the role exists) and an existing one converge on the same state.
    const file = join(process.cwd(), "..", "..", "infra", "portal-role.sql");
    await sql.unsafe(readFileSync(file, "utf8"));

    await sql`insert into workspaces (id, name, slug) values
      (${openWs}, 'Published Co', ${`open-${suffix}`}),
      (${shutWs}, 'Private Co', ${`shut-${suffix}`})`;

    await sql`insert into products (id, workspace_id, key, name) values
      (${shownProduct}, ${openWs}, ${`shown-${suffix}`}, 'Shown Product'),
      (${unannouncedProduct}, ${openWs}, ${`secret-${suffix}`}, 'Unannounced Product'),
      (${shutProduct}, ${shutWs}, ${`priv-${suffix}`}, 'Private Product')`;

    // One workspace publishes: portal on, one product, one stage, roadmap off.
    // The other has a portal row but has never switched it on.
    await sql`insert into idea_settings
        (workspace_id, portal_enabled, portal_idea_statuses, portal_roadmap_enabled, portal_roadmap_item_statuses)
      values
        (${openWs}, true, array['planned'], false, array['in_progress']),
        (${shutWs}, false, array['planned'], true, array['in_progress'])`;

    await sql`insert into idea_portal_products (workspace_id, product_id)
      values (${openWs}, ${shownProduct})`;

    await sql`insert into ideas (id, workspace_id, product_id, title, status) values
      (${publishedIdea}, ${openWs}, ${shownProduct}, 'Published idea', 'planned'),
      (${declinedIdea}, ${openWs}, ${shownProduct}, 'Declined idea', 'declined'),
      (${unannouncedIdea}, ${openWs}, ${unannouncedProduct}, 'Idea in unannounced product', 'planned'),
      (${shutIdea}, ${shutWs}, ${shutProduct}, 'Other workspace idea', 'planned')`;

    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${openWs}, ${`feature-${suffix}`}, 'Feature', 0, false)`;
    await sql`insert into features (id, workspace_id, product_id, spec_id, level, title, status)
      values (${roadmapItem}, ${openWs}, ${shownProduct}, ${roadmapItem},
              ${`feature-${suffix}`}, 'Roadmap item', 'in_progress')`;
  });

  afterAll(async () => {
    await sql`delete from features where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from workspace_levels where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from ideas where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from idea_portal_products where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from idea_settings where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from products where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from workspaces where id in ${sql([openWs, shutWs])}`;
    await sql.end({ timeout: 5 });
  });

  it("shows only ideas in a published product, at a published stage", async () => {
    // All four ideas exist and all four are readable on the owner connection.
    // Three of them are somebody's private business, and each is excluded for a
    // different reason: a stage nobody chose to publish, a product nobody chose
    // to publish, and a portal that was never switched on.
    const rows = await asPortal(
      (tx) => tx<{ title: string }[]>`select title from ideas`,
    );
    expect(titles(rows)).toEqual(["Published idea"]);
  });

  it("hides the name of a product the workspace has not published", async () => {
    // The product NAME is the leak here, not its contents. A company running a
    // portal usually has something unannounced in the backlog beside the thing
    // they are collecting feedback on.
    const rows = await asPortal(
      (tx) => tx<{ name: string }[]>`select name from products`,
    );
    expect(rows.map((r) => r.name)).toEqual(["Shown Product"]);
  });

  it("will not confirm that an unpublished workspace exists", async () => {
    // A portal is addressed by workspace slug, so a readable row for a
    // workspace with no portal turns this connection into an oracle for which
    // companies have accounts.
    const rows = await asPortal(
      (tx) => tx<{ name: string }[]>`select name from workspaces`,
    );
    expect(rows.map((r) => r.name)).toEqual(["Published Co"]);
  });

  it("gates the roadmap separately from the ideas portal", async () => {
    // Wanting feedback in the open is not the same decision as publishing what
    // you plan to build and when. `openWs` has the portal on and the roadmap
    // off, which is the combination that would leak if the two shared a switch.
    const before = await asPortal(
      (tx) => tx<{ title: string }[]>`select title from features`,
    );
    expect(before).toEqual([]);

    await sql`update idea_settings set portal_roadmap_enabled = true
      where workspace_id = ${openWs}`;
    try {
      const after = await asPortal(
        (tx) => tx<{ title: string }[]>`select title from features`,
      );
      expect(titles(after)).toEqual(["Roadmap item"]);
    } finally {
      await sql`update idea_settings set portal_roadmap_enabled = false
        where workspace_id = ${openWs}`;
    }
  });

  it("hides everything the moment the portal is switched off", async () => {
    // The kill switch has to be one setting, and it has to be total. An admin
    // turning a portal off is usually doing it in a hurry.
    await sql`update idea_settings set portal_enabled = false where workspace_id = ${openWs}`;
    try {
      const seen = await asPortal(async (tx) => ({
        ideas: await tx`select 1 from ideas`,
        products: await tx`select 1 from products`,
        workspaces: await tx`select 1 from workspaces`,
      }));
      expect(seen.ideas).toEqual([]);
      expect(seen.products).toEqual([]);
      expect(seen.workspaces).toEqual([]);
    } finally {
      await sql`update idea_settings set portal_enabled = true where workspace_id = ${openWs}`;
    }
  });

  it("cannot write anything at all", async () => {
    // Submissions and votes are writes and go through their own intake path.
    // This role reads published rows, and a missing grant is a much harder
    // thing to get wrong later than a policy predicate.
    const writes = [
      (tx: postgres.TransactionSql) =>
        tx`insert into ideas (workspace_id, title, status) values (${openWs}, 'injected', 'planned')`,
      (tx: postgres.TransactionSql) => tx`update ideas set title = 'edited'`,
      (tx: postgres.TransactionSql) => tx`delete from ideas`,
      // The one that would defeat every policy above by rewriting the rules
      // the policies read.
      (tx: postgres.TransactionSql) =>
        tx`update idea_settings set portal_idea_statuses = array['planned', 'declined']`,
      (tx: postgres.TransactionSql) =>
        tx`insert into idea_portal_products (workspace_id, product_id) values (${openWs}, ${unannouncedProduct})`,
    ];
    for (const write of writes) {
      await expect(asPortal(write)).rejects.toThrow(/permission denied/);
    }
  });

  it("stays bounded even if a session user is set on the connection", async () => {
    // The failure this design must not have.
    //
    // The membership policies these tables already carry (`ideas_member_all`)
    // are `TO public`, which includes this role, and permissive policies OR
    // together. So what the portal role may read is really
    // `specboards_is_member(...) OR <published>`, and the left side is only
    // false because nothing sets `app.user_id` on this connection.
    //
    // That is a property of today's call sites, not of the database, and it
    // fails open: one `set_config('app.user_id', ...)` reaching here would hand
    // an anonymous visitor every row in any workspace that user belongs to.
    // The RESTRICTIVE clamp policies exist for exactly this, and this is the
    // case that would fail without them.
    const member = randomUUID();
    await sql`insert into users (id, name, email)
      values (${member}, 'Insider', ${`insider-${suffix}@portal.test`})`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${openWs}, ${member}, 'owner'), (${shutWs}, ${member}, 'owner')`;
    try {
      const rows = await sql.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${member}, true)`;
        await tx`set local role specboards_portal`;
        return tx<{ title: string }[]>`select title from ideas`;
      });
      // Still only the published one, though this user can see all four on the
      // app connection.
      expect(titles(rows as { title: string }[])).toEqual(["Published idea"]);
    } finally {
      await sql`delete from members where user_id = ${member}`;
      await sql`delete from users where id = ${member}`;
    }
  });

  it("cannot reach a table it was never granted", async () => {
    // The blanket grant in `rls-role.sql` gives `specboards_app` every table and
    // sets ALTER DEFAULT PRIVILEGES so future ones follow. `portal-role.sql`
    // does neither, deliberately: a table added by a later migration must be
    // granted to the public reader on purpose. This is that promise, asserted.
    for (const table of ["members", "notifications", "api_keys", "comments"]) {
      await expect(
        asPortal((tx) => tx.unsafe(`select 1 from ${table}`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
