import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>;

/**
 * Create a Drizzle client from a Postgres connection string (self-host
 * compose stack or hosted Postgres). Tenant isolation is enforced by RLS at
 * the database layer, so callers must connect with an appropriately scoped role.
 */
export function createDb(connectionString: string) {
  const sql = postgres(connectionString, {
    prepare: false,
    // Resilience for long-lived, bursty callers (the MCP endpoint especially).
    // MCP sessions sit idle between tool calls, and managed Postgres / the Fly
    // proxy silently reap idle TCP connections; without an idle timeout the pool
    // hands back a dead socket and the next query fails with ECONNRESET. Closing
    // idle connections ourselves (and recycling long-lived ones) means the pool
    // only ever holds sockets it can trust, and reconnects are bounded.
    idle_timeout: 30, // close a connection after 30s idle
    max_lifetime: 60 * 30, // recycle a connection after 30 min
    connect_timeout: 15, // fail fast instead of hanging a request on reconnect
    max: 10, // pool ceiling per process (auth + store pools share the DB budget)
  });
  return drizzle(sql, { schema });
}

export { schema };
