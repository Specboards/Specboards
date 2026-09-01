import { expect, test } from "@playwright/test";

/**
 * `/api/health` is the endpoint an operator points monitoring at, and the one
 * we ask them to curl on a support call. It answered a bare `ok`, which proves
 * only that Node is accepting connections: not which build is running, not
 * whether the database is reachable, not whether migrations landed. A self-host
 * has no Fly dashboard to fall back on.
 *
 * The split matters as much as the addition. Fly's health check owns the bare
 * path and it must keep not touching Postgres, because a transient database
 * blip should not make Fly restart otherwise-healthy machines.
 */
test.describe("health endpoint", () => {
  test("the bare probe stays a plain ok, for the restart loop", async ({ page }) => {
    const res = await page.request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers()["cache-control"]).toBe("no-store");
  });

  test("the full probe reports the build and the database", async ({ page }) => {
    const res = await page.request.get("/api/health?full=1");
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      status: string;
      version: string | null;
      revision: string | null;
      database: { reachable: boolean; migrations: number | null };
    };

    expect(body.status).toBe("ok");
    // The E2E server runs against a migrated database, so this is the assertion
    // that the check actually queried something rather than reporting a
    // hardcoded shape.
    expect(body.database.reachable).toBe(true);
    expect(body.database.migrations).toBeGreaterThan(0);

    // version/revision are null here (nothing sets them outside a container
    // build), so the contract asserted is the keys' presence, not their values.
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("revision");
    expect(res.headers()["cache-control"]).toBe("no-store");
  });
});
