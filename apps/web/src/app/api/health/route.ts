import { sql } from "@specboards/db";

import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness and readiness, split by query rather than by route.
 *
 * `GET /api/health` stays exactly what it was: 200 and the bare string `ok`,
 * touching nothing. That contract belongs to Fly's health check, and it must
 * keep not touching Postgres - a transient database blip should not make Fly
 * kill and restart otherwise-healthy machines, which would flap and drop
 * in-flight MCP requests. Readiness does not belong in the restart loop.
 *
 * `GET /api/health?full=1` is the one an operator and their monitoring want.
 * The bare version proves only that Node is accepting connections, which is
 * thin for the endpoint we ask people to curl on a support call: it cannot say
 * which build is running, whether the database is reachable, or whether
 * migrations landed. Self-host has no Fly dashboard to fall back on.
 *
 * Reporting the build here is what makes it answerable at all: the commit was
 * previously baked only into the client bundle, so the only way to read it was
 * to load and scrape a rendered page.
 */
interface FullHealth {
  status: "ok" | "degraded";
  version: string | null;
  revision: string | null;
  database: { reachable: boolean; migrations: number | null };
}

async function fullHealth(): Promise<FullHealth> {
  const version = process.env.SPECBOARDS_VERSION?.trim() || null;
  const revision =
    process.env.SPECBOARDS_GIT_SHA?.trim() ||
    process.env.NEXT_PUBLIC_GIT_SHA?.trim() ||
    null;

  const db = getDb();
  if (!db) {
    // Local file mode: no database is the configured state, not a fault.
    return { status: "ok", version, revision, database: { reachable: false, migrations: null } };
  }

  try {
    // Counting the migration journal is the cheapest thing that proves both
    // that the connection works and that the schema was actually installed. The
    // relation matches the runner in `packages/db/src/migrate.ts`; an empty
    // journal and a missing one both mean "nothing applied", which is the state
    // of a database that came up before its first migration.
    const rows = await db.execute(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    const count = Number((rows as unknown as { count: string }[])[0]?.count ?? 0);
    return {
      status: "ok",
      version,
      revision,
      database: { reachable: true, migrations: Number.isFinite(count) ? count : null },
    };
  } catch (err) {
    // 3F000 (no schema) / 42P01 (no table): reachable, but unmigrated. That is
    // a real and actionable state for a self-host, and distinct from the
    // database being down, so it must not be reported as unreachable.
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "3F000" || code === "42P01") {
      return {
        status: "degraded",
        version,
        revision,
        database: { reachable: true, migrations: 0 },
      };
    }
    console.error("[health] database check failed:", err);
    return {
      status: "degraded",
      version,
      revision,
      database: { reachable: false, migrations: null },
    };
  }
}

export async function GET(req: Request) {
  if (!new URL(req.url).searchParams.has("full")) {
    return new Response("ok", {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  }

  const body = await fullHealth();
  // 200 even when degraded: this is a report, and a monitor that cannot read
  // the body of a 503 learns less than one that can read the body of a 200.
  // The `status` field is the signal to alert on.
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
