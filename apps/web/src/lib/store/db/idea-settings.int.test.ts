import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The published product set, which is the one part of the Ideas settings that
 * is a table rather than a column.
 *
 * Two things are worth pinning here and neither is visible from the type. The
 * set REPLACES rather than merges, because the form sends what is ticked and a
 * merge could never unpublish anything. And an id is filtered against the
 * acting workspace before insert, so a stale or hostile id in a form submission
 * cannot publish another tenant's product.
 *
 * The composite `(product_id, workspace_id)` foreign key refuses a foreign id
 * regardless, so these cases are about which of the two answers the user gets:
 * the id being dropped and the save succeeding, or the whole save failing with
 * a constraint error nobody can act on.
 *
 * Exercised through SQL rather than the store, because the store's `scoped()`
 * wants a resolved membership and everything under test here is the write
 * itself. Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const wsA = randomUUID();
const wsB = randomUUID();
const productA1 = randomUUID();
const productA2 = randomUUID();
const productB = randomUUID();
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!DB_URL)("idea portal published products", () => {
  let sql: postgres.Sql;

  /** The store's replace-then-insert, as `updateIdeaSettings` performs it. */
  async function publish(ws: string, ids: string[]): Promise<string[]> {
    return sql.begin(async (tx) => {
      const owned: { id: string }[] = ids.length
        ? await tx`select id from products
                   where workspace_id = ${ws} and id in ${tx(ids)}`
        : [];
      const ownedIds = new Set(owned.map((p) => p.id));
      // Deduplicated, as the store does.
      const kept = [...new Set(ids)].filter((id) => ownedIds.has(id));

      await tx`delete from idea_portal_products where workspace_id = ${ws}`;
      for (const productId of kept) {
        await tx`insert into idea_portal_products (workspace_id, product_id)
                 values (${ws}, ${productId})`;
      }
      const rows: { product_id: string }[] =
        await tx`select product_id from idea_portal_products where workspace_id = ${ws}`;
      return rows.map((r) => r.product_id).sort();
    }) as Promise<string[]>;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug) values
      (${wsA}, 'Portal A', ${`pa-${suffix}`}),
      (${wsB}, 'Portal B', ${`pb-${suffix}`})`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${productA1}, ${wsA}, ${`a1-${suffix}`}, 'A One'),
      (${productA2}, ${wsA}, ${`a2-${suffix}`}, 'A Two'),
      (${productB}, ${wsB}, ${`b1-${suffix}`}, 'B One')`;
  });

  afterAll(async () => {
    await sql`delete from idea_portal_products where workspace_id in ${sql([wsA, wsB])}`;
    await sql`delete from products where workspace_id in ${sql([wsA, wsB])}`;
    await sql`delete from workspaces where id in ${sql([wsA, wsB])}`;
    await sql.end({ timeout: 5 });
  });

  it("replaces the set rather than adding to it", async () => {
    expect(await publish(wsA, [productA1, productA2])).toEqual(
      [productA1, productA2].sort(),
    );
    // Unticking one has to actually unpublish it. A merge-only write would
    // leave the product published while the form showed it was not, which is
    // the failure mode that matters: the admin believes they have withdrawn it.
    expect(await publish(wsA, [productA1])).toEqual([productA1]);
  });

  it("clears the set when given an empty list", async () => {
    // The only way to publish nothing, and distinct from not sending the field.
    expect(await publish(wsA, [])).toEqual([]);
  });

  it("drops another workspace's product instead of failing the save", async () => {
    // A stale id (a product deleted in another tab) or a tampered form should
    // not 500. The row is simply not created, and the ids that were legitimate
    // are still saved.
    expect(await publish(wsA, [productA1, productB])).toEqual([productA1]);
  });

  it("cannot publish another workspace's product even past the filter", async () => {
    // The backstop, asserted directly: if the app-code filter above were ever
    // removed or wrong, the composite foreign key still refuses. This is the
    // guarantee that makes the table worth having over a column of ids.
    await expect(
      sql`insert into idea_portal_products (workspace_id, product_id)
          values (${wsA}, ${productB})`,
    ).rejects.toThrow(/idea_portal_products_product_ws_fk/);
  });

  it("is idempotent for a repeated product", async () => {
    // Found by writing this: the store did not deduplicate and relied on
    // `parseKeySet` in the service having done it, so a caller that was not the
    // settings form (the MCP surface, a script) got a constraint error naming a
    // table it never mentioned. Both layers deduplicate now.
    expect(await publish(wsA, [productA1, productA1])).toEqual([productA1]);
    await expect(
      sql`insert into idea_portal_products (workspace_id, product_id)
          values (${wsA}, ${productA1})`,
    ).rejects.toThrow(/idea_portal_products_ws_product_uq/);
  });

  it("unpublishes a product when it is deleted", async () => {
    // ON DELETE CASCADE, so removing a product cannot leave it published. The
    // alternative is a portal advertising a product that no longer exists.
    const doomed = randomUUID();
    await sql`insert into products (id, workspace_id, key, name)
      values (${doomed}, ${wsA}, ${`tmp-${suffix}`}, 'Temporary')`;
    await publish(wsA, [productA1, doomed]);
    await sql`delete from products where id = ${doomed}`;

    const rows: { product_id: string }[] =
      await sql`select product_id from idea_portal_products where workspace_id = ${wsA}`;
    expect(rows.map((r) => r.product_id)).toEqual([productA1]);
  });
});
