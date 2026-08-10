import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `revalidatePath` reaches for Next's per-request store, which only exists
 * inside a real request. Calling the handler directly is the point of this
 * file, so the cache hint is recorded rather than performed; the assertion
 * below keeps it from being silently dropped instead.
 */
const revalidated: string[] = [];
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

/**
 * End-to-end proof of who may configure transitions, through the real route.
 *
 * `transition-mode.int.test.ts` proves the database refuses the wrong writer.
 * This proves the route refuses them *first*, and with a 403 rather than a
 * failed write, because the two failures look identical to a user and only one
 * of them is a usable error message. It also covers the widening this slice
 * introduced: PATCH used to be workspace-owner-only, and a product admin now
 * gets through it for their own product and no further.
 *
 * A real `sb_` key on a real Request driving the real handler, following
 * `mcp/scope-enforcement.int.test.ts`: the interesting bugs here live in the
 * plumbing (which authorization runs, and on what) rather than in a predicate.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const slug = `statusroute-${randomUUID().slice(0, 8)}`;
const ws = randomUUID();
const ownerId = randomUUID();
const alphaAdminId = randomUUID();
const memberId = randomUUID();
const alpha = randomUUID();
const beta = randomUUID();

describe.skipIf(!DB_URL)("PATCH /api/v1/statuses authorization", () => {
  let sql: postgres.Sql;
  let ownerKey: string;
  let alphaAdminKey: string;
  let memberKey: string;
  let PATCH: typeof import("@/app/api/v1/statuses/route").PATCH;
  let GET: typeof import("@/app/api/v1/statuses/route").GET;

  function patch(key: string, body: unknown): Request {
    return new Request("https://app.example.test/api/v1/statuses", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${key}`,
        "x-org-slug": slug,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  function get(key: string, productId?: string): Request {
    const url = new URL("https://app.example.test/api/v1/statuses");
    if (productId) url.searchParams.set("productId", productId);
    return new Request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, "x-org-slug": slug },
    });
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    const db = createDb(DB_URL!);
    ({ PATCH, GET } = await import("@/app/api/v1/statuses/route"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Status Route', ${slug})`;
    await sql`insert into users (id, name, email) values
      (${ownerId}, 'Owner', ${`owner-${slug}@r.test`}),
      (${alphaAdminId}, 'Alpha admin', ${`alpha-${slug}@r.test`}),
      (${memberId}, 'Member', ${`member-${slug}@r.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${ownerId}, 'owner'),
      (${ws}, ${alphaAdminId}, 'member'),
      (${ws}, ${memberId}, 'member')`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${alpha}, ${ws}, 'alpha', 'Alpha'),
      (${beta}, ${ws}, 'beta', 'Beta')`;
    await sql`insert into product_members (workspace_id, product_id, user_id, role)
      values (${ws}, ${alpha}, ${alphaAdminId}, 'admin')`;
    await sql`insert into product_settings (workspace_id, product_id, transition_mode)
      values (${ws}, null, 'flexible')`;

    const { createApiKey } = await import("@/lib/api-keys");
    // Full-access keys: the only thing under test is the caller's role, not
    // what their key was scoped to (that is api-scopes' job).
    ownerKey = (await createApiKey(db, ownerId, "owner", null, [])).key;
    alphaAdminKey = (await createApiKey(db, alphaAdminId, "alpha", null, [])).key;
    memberKey = (await createApiKey(db, memberId, "member", null, [])).key;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in
      (${ownerId}, ${alphaAdminId}, ${memberId})`;
    await sql.end({ timeout: 5 });
  });

  it("lets the owner set the workspace default", async () => {
    revalidated.length = 0;
    const res = await PATCH(patch(ownerKey, { transitionMode: "strict" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ transitionMode: "strict" });
    // The boards render the workflow, so a save nobody revalidates shows the
    // old rules until the next full load.
    expect(revalidated).toContain("/[org]/[product]/backlog");
  });

  it("refuses a product admin on the workspace default", async () => {
    const res = await PATCH(patch(alphaAdminKey, { transitionMode: "flexible" }));
    expect(res.status).toBe(403);
  });

  it("lets a product admin configure their own product", async () => {
    const res = await PATCH(
      patch(alphaAdminKey, { transitionMode: "flexible", productId: alpha }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ transitionMode: "flexible" });
  });

  it("refuses a product admin on another product", async () => {
    const res = await PATCH(
      patch(alphaAdminKey, { transitionMode: "flexible", productId: beta }),
    );
    expect(res.status).toBe(403);
    const [row] = await sql`select transition_mode from product_settings
      where workspace_id = ${ws} and product_id = ${beta}`;
    expect(row?.transition_mode ?? null).toBeNull();
  });

  it("refuses a plain member on a product and on the default", async () => {
    expect(
      (await PATCH(patch(memberKey, { transitionMode: "flexible", productId: alpha })))
        .status,
    ).toBe(403);
    expect(
      (await PATCH(patch(memberKey, { transitionMode: "flexible" }))).status,
    ).toBe(403);
  });

  it("lets the owner configure any product", async () => {
    const res = await PATCH(
      patch(ownerKey, { transitionMode: "flexible", productId: beta }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a null mode on the workspace default", async () => {
    const res = await PATCH(patch(ownerKey, { transitionMode: null }));
    expect(res.status).toBe(422);
  });

  it("reverts a product to inheriting, and reports what it inherits", async () => {
    await PATCH(patch(ownerKey, { transitionMode: "strict" }));
    await PATCH(
      patch(ownerKey, { transitionMode: "flexible", productId: alpha }),
    );

    const res = await PATCH(
      patch(alphaAdminKey, { transitionMode: null, productId: alpha }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ transitionMode: "strict" });
  });

  it("rejects a mode that is neither a stage policy nor null", async () => {
    const res = await PATCH(patch(ownerKey, { transitionMode: "sideways" }));
    expect(res.status).toBe(422);
  });

  it("resolves GET per product, and the default without one", async () => {
    await PATCH(patch(ownerKey, { transitionMode: "strict" }));
    await PATCH(patch(ownerKey, { transitionMode: "flexible", productId: beta }));

    const forBeta = (await (await GET(get(memberKey, beta))).json()) as {
      transitionMode: string;
      workflow: { transitions: Record<string, string[]> };
    };
    const forWorkspace = (await (await GET(get(memberKey))).json()) as {
      transitionMode: string;
      workflow: { transitions: Record<string, string[]> };
    };

    expect(forBeta.transitionMode).toBe("flexible");
    expect(forWorkspace.transitionMode).toBe("strict");
    // Not just the label: the resolved graph a client plans moves with really
    // differs, which is the whole point of configuring this per product.
    expect(forBeta.workflow.transitions.backlog!.length).toBeGreaterThan(
      forWorkspace.workflow.transitions.backlog!.length,
    );
  });
});
